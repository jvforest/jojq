#!/usr/bin/env node

const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');
const tls = require('tls');
const zlib = require('zlib');
const { getColor } = require('./config');
const { CertificateManager } = require('./certs');

// ============= HTTP PROXY SERVER =============

/**
 * ProxyServer - HTTP/HTTPS proxy server for intercepting and analyzing JSON responses
 * 
 * @class
 * @description Provides an HTTP/HTTPS proxy server that captures JSON responses
 * and allows interactive analysis with jojq TUI. Supports MITM for HTTPS inspection.
 */
class ProxyServer {
  /**
   * Create a proxy server
   * 
   * @param {number} [port=8888] - Port number to listen on
   * @param {boolean} [insecure=false] - Enable HTTPS MITM mode
   * @param {Function} [onResponseCaptured] - Optional callback when response is captured
   */
  constructor(port = 8888, insecure = false, onResponseCaptured) {
    this.port = port;
    this.insecure = insecure;
    this.onResponseCaptured = onResponseCaptured;
    this.server = null;
    this.capturedResponses = [];
    this.maxCapturedResponses = 100; // Limit to prevent memory issues
    this.certManager = null;
  }
  
  /**
   * Initialize the proxy server (loads or generates CA certificates for HTTPS MITM)
   * 
   * @async
   * @returns {Promise<void>}
   */
  async initialize() {
    // Initialize certificate manager for HTTPS MITM
    if (this.insecure) {
      this.certManager = new CertificateManager();
      await this.certManager.loadOrGenerateCA();
    }
  }

  /**
   * Start the proxy server
   * 
   * @param {boolean} [interactive=false] - Enable interactive mode for analyzing responses
   * @returns {void}
   */
  start(interactive = false) {
    this.interactive = interactive;
    
    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Handle HTTPS CONNECT requests
    this.server.on('connect', (req, clientSocket, head) => {
      this.handleHttpsConnect(req, clientSocket, head);
    });

    this.server.listen(this.port, () => {
      console.log(getColor('success')(`\n✓ jojq proxy server running on port ${this.port}`));
      console.log(getColor('info')(`\n📡 Configure Postman proxy settings:`));
      console.log(getColor('prompt')(`   Proxy Type: HTTP`));
      console.log(getColor('prompt')(`   Proxy Server: localhost:${this.port}`));
      console.log(getColor('info')(`\n💡 HTTP requests will be captured and available for analysis`));
      
      if (this.insecure && this.certManager) {
        console.log(getColor('success')(`   ✓ HTTPS MITM mode enabled - will inspect HTTPS traffic`));
        console.log(getColor('warning')(`\n   ⚠️  IMPORTANT: Install CA certificate in Postman:`));
        console.log(getColor('info')(`   1. Go to Postman Settings → Certificates`));
        console.log(getColor('info')(`   2. Click "Add Certificate" (under CA Certificates)`));
        console.log(getColor('info')(`   3. Select the CA cert file:`));
        console.log(getColor('prompt')(`      ${this.certManager.getCACertPath()}`));
        console.log(getColor('info')(`   4. Turn OFF "SSL certificate verification" in Settings → General\n`));
      } else {
        console.log(getColor('warning')(`   ⚠️  HTTPS requests will be tunneled through (not inspected)`));
        console.log(getColor('info')(`   → To inspect HTTPS: Use --insecure flag`));
        console.log(getColor('info')(`   → Or test with HTTP endpoints (e.g., http://httpbin.org/json)\n`));
      }
      
      console.log(getColor('dim')(`Press Ctrl+C to force stop, or exit TUI for save options\n`));
      
      if (interactive) {
        console.log(getColor('prompt')(`📝 Type a response number to analyze it interactively`));
        console.log(getColor('dim')(`   Example: Type '1' to analyze response #1`));
        console.log(getColor('dim')(`   Type 'help' for available commands`));
        console.log(getColor('dim')(`   When exiting TUI: option to save captured responses\n`));
        this.setupInteractiveMode();
      }
    });

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(getColor('error')(`\n❌ Port ${this.port} is already in use`));
        console.error(getColor('info')(`   Try a different port: jojq --proxy <port>\n`));
      } else {
        console.error(getColor('error')(`\n❌ Proxy server error: ${err.message}\n`));
      }
      process.exit(1);
    });
  }
  
  setupInteractiveMode() {
    const readline = require('readline');
    
    // Enable keypress events on stdin
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: ''
    });
    
    this.rl.on('line', (input) => {
      const trimmed = input.trim();
      
      // Check if input is a number
      if (/^\d+$/.test(trimmed)) {
        const index = parseInt(trimmed, 10) - 1;
        if (index >= 0 && index < this.capturedResponses.length) {
          this.analyzeResponse(index);
        } else {
          console.log(getColor('warning')(`⚠️  Invalid response number. Available: 1-${this.capturedResponses.length}`));
        }
      } else if (trimmed === 'list' || trimmed === 'ls') {
        this.listResponses();
      } else if (trimmed === 'clear') {
        this.capturedResponses = [];
        console.log(getColor('success')('✓ Cleared all captured responses'));
      } else if (trimmed === 'help') {
        console.log(getColor('info')('Available commands:'));
        console.log(getColor('prompt')('  <number>  - Analyze captured response by number'));
        console.log(getColor('prompt')('  list, ls   - List all captured responses'));
        console.log(getColor('prompt')('  clear      - Clear captured responses'));
        console.log(getColor('prompt')('  help       - Show this help'));
        console.log(getColor('prompt')('  exit, quit - Stop the proxy'));
      } else if (trimmed === 'exit' || trimmed === 'quit') {
        console.log(getColor('dim')('👋 Goodbye!'));
        process.exit(0);
      } else if (trimmed && trimmed !== '') {
        console.log(getColor('warning')(`❌ Unknown command: ${trimmed}`));
        console.log(getColor('info')('   Type "help" for available commands'));
      }
      
      // Don't show prompt, just wait for next input
    });
  }
  
  listResponses() {
    if (this.capturedResponses.length === 0) {
      console.log(getColor('dim')('\n📭 No responses captured yet\n'));
      return;
    }
    
    console.log(getColor('success')(`\n✓ Captured ${this.capturedResponses.length} response(s):\n`));
    this.capturedResponses.forEach((resp, index) => {
      const size = JSON.stringify(resp.response.body).length;
      console.log(getColor('warning')(`  [${index + 1}] `) + getColor('info')(`${resp.request.method} ${resp.request.url}`));
      console.log(getColor('dim')(`      Status: ${resp.response.statusCode}, Size: ${size} bytes\n`));
    });
  }
  
  analyzeResponse(index) {
    const captured = this.capturedResponses[index];
    if (!captured) return;
    
    console.log(getColor('success')(`\n✓ Analyzing response #${index + 1}:`));
    console.log(getColor('info')(`  URL: ${captured.request.url}`));
    console.log(getColor('info')(`  Method: ${captured.request.method}`));
    console.log(getColor('info')(`  Status: ${captured.response.statusCode}`));
    
    try {
      // Pass the full captured object (request + response) to TUI
      const jsonString = JSON.stringify(captured, null, 2);
      
      console.log(getColor('info')(`  Size: ${jsonString.length} bytes\n`));
      console.log(getColor('prompt')('🔍 Launching interactive jojq...\n'));
      
      // Close the proxy readline interface to avoid conflicts
      if (this.rl) {
        this.rl.removeAllListeners();
        this.rl.close();
        this.rl = null;
      }
      
      console.log(getColor('info')('\n🎨 Launching TUI mode...\n'));
      this.launchTUI(captured);
      
    } catch (error) {
      console.log(getColor('error')(`\n❌ Failed to display JSON: ${error.message}\n`));
      console.log(getColor('dim')('Response type: ' + typeof captured));
      console.log('\n');
    }
  }
  
  launchTUI(jsonData) {
    // Close proxy readline
    if (this.rl) {
      this.rl.close();
    }
    
    // Launch the full TUI with the captured JSON
    const { JojqTUI } = require('../index.tui');
    const tui = new JojqTUI(jsonData, true); // Pass true for proxyMode
    tui.init(); // Initialize the TUI (creates screen and UI)
    
    // When TUI exits, show exit prompt (only once)
    let exitHandled = false;
    tui.screen.on('destroy', () => {
      if (!exitHandled) {
        exitHandled = true;
        // Small delay to let terminal fully reset after blessed exit
        setTimeout(() => {
          this.showExitPrompt();
        }, 100);
      }
    });
  }
  
  /**
   * Show exit prompt when user exits from TUI
   * Allows user to return to proxy, exit, or save captured responses
   * 
   * @returns {void}
   */
  showExitPrompt() {
    const readline = require('readline');
    const fs = require('fs');
    const tty = require('tty');
    
    // Reset terminal state after blessed exits
    // This is critical - blessed leaves the terminal in raw mode
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    
    // Use /dev/tty for clean input/output
    try {
      const fd = fs.openSync('/dev/tty', 'r+');
      const ttyInput = new tty.ReadStream(fd);
      const ttyOutput = new tty.WriteStream(fd);
      
      ttyOutput.write(getColor('prompt')('\n🚪 Exit proxy mode?\n'));
      ttyOutput.write(getColor('info')('  [r] Return to proxy mode (continue capturing)\n'));
      ttyOutput.write(getColor('info')('  [k] Kill proxy and exit\n'));
      ttyOutput.write(getColor('info')('  [s] Save captured responses and exit\n'));
      ttyOutput.write(getColor('info')('  [c] Choose specific requests to save and exit\n'));
      ttyOutput.write('\n');
      
      const rl = readline.createInterface({
        input: ttyInput,
        output: ttyOutput
      });
    
      rl.question(getColor('prompt')('Choice [r/k/s/c]: '), (answer) => {
        const choice = answer.trim().toLowerCase();
        
        if (choice === 'r' || choice === '') {
          // Return to proxy mode
          ttyOutput.write(getColor('dim')('\n↩️  Returning to proxy mode...\n'));
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          
          // Resume stdin for proxy mode
          process.stdin.resume();
          this.setupInteractiveMode();
        } else if (choice === 'k') {
          // Kill proxy and exit
          ttyOutput.write(getColor('dim')('\n👋 Goodbye!\n'));
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          this.stop();
          process.exit(0);
        } else if (choice === 's') {
          // Save all responses
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          this.saveAllResponses(() => {
            console.log(getColor('dim')('\n👋 Goodbye!'));
            this.stop();
            process.exit(0);
          });
        } else if (choice === 'c') {
          // Choose specific responses to save
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          this.chooseResponsesToSave(() => {
            console.log(getColor('dim')('\n👋 Goodbye!'));
            this.stop();
            process.exit(0);
          });
        } else {
          ttyOutput.write(getColor('warning')(`\n⚠️  Invalid choice. Returning to proxy mode...\n`));
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          
          // Resume stdin for proxy mode
          process.stdin.resume();
          this.setupInteractiveMode();
        }
      });
    } catch (error) {
      // Fallback if /dev/tty is not available
      console.error('Failed to open TTY:', error);
      console.log('\n↩️  Returning to proxy mode...\n');
      
      // Resume stdin for proxy mode
      process.stdin.resume();
      this.setupInteractiveMode();
    }
  }
  
  saveAllResponses(callback) {
    if (this.capturedResponses.length === 0) {
      console.log(getColor('warning')('\n⚠️  No responses to save.\n'));
      if (callback) callback();
      return;
    }
    
    // If multiple responses, ask if single file or individual files
    if (this.capturedResponses.length > 1) {
      const readline = require('readline');
      const fs = require('fs');
      const tty = require('tty');
      
      try {
        const fd = fs.openSync('/dev/tty', 'r+');
        const ttyInput = new tty.ReadStream(fd);
        const ttyOutput = new tty.WriteStream(fd);
        
        const rl = readline.createInterface({
          input: ttyInput,
          output: ttyOutput,
          terminal: true
        });
        
        rl.question(getColor('prompt')(`\n💾 Save as [s]ingle file or [i]ndividual files? (default: single): `), (choice) => {
          const saveMode = choice.trim().toLowerCase();
          
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          
          if (saveMode === 'i' || saveMode === 'individual') {
            // Individual files mode
            this.saveIndividualResponses(this.capturedResponses, callback);
          } else {
            // Single file mode (default)
            this.saveAllToSingleFile(callback);
          }
        });
      } catch (error) {
        console.error('Failed to open TTY:', error);
        if (callback) callback();
      }
    } else {
      // Single response, just save it
      this.saveAllToSingleFile(callback);
    }
  }
  
  saveAllToSingleFile(callback) {
    const readline = require('readline');
    const fs = require('fs');
    const path = require('path');
    const tty = require('tty');
    
    try {
      // Use /dev/tty for input
      const fd = fs.openSync('/dev/tty', 'r+');
      const ttyInput = new tty.ReadStream(fd);
      const ttyOutput = new tty.WriteStream(fd);
      
      // Tab completion function for file paths
      const completer = FileManager.createPathCompleter();
      
      const rl = readline.createInterface({
        input: ttyInput,
        output: ttyOutput,
        completer: completer,
        terminal: true
      });
      
      const defaultFilename = 'captured-responses.json';
      ttyOutput.write(getColor('info')(`💡 Tip: Press Tab for autocomplete\n`));
      
      rl.question(getColor('prompt')(`\n💾 Save as (default: ${defaultFilename} in current directory): `), (savePath) => {
        let finalPath = savePath.trim();
        
        // If empty, use default filename in current directory
        if (!finalPath) {
          finalPath = path.join(process.cwd(), defaultFilename);
        } else {
          // Expand tilde to home directory
          if (finalPath.startsWith('~/')) {
            const os = require('os');
            finalPath = path.join(os.homedir(), finalPath.slice(2));
          }
          
          // If relative path, resolve from current directory
          if (!path.isAbsolute(finalPath)) {
            finalPath = path.resolve(process.cwd(), finalPath);
          }
          
          // If it's a directory, append default filename
          try {
            const stats = fs.statSync(finalPath);
            if (stats.isDirectory()) {
              finalPath = path.join(finalPath, defaultFilename);
            }
          } catch (err) {
            // File doesn't exist, that's fine - we'll create it
          }
        }
        
        try {
          fs.writeFileSync(finalPath, JSON.stringify(this.capturedResponses, null, 2), 'utf8');
          ttyOutput.write(getColor('success')(`\n✓ Saved ${this.capturedResponses.length} response(s) to: ${finalPath}\n`));
        } catch (err) {
          ttyOutput.write(getColor('error')(`\n❌ Failed to save responses: ${err.message}\n`));
        }
        
        rl.close();
        ttyInput.destroy();
        ttyOutput.destroy();
        if (callback) callback();
      });
    } catch (error) {
      console.error('Failed to open TTY for save:', error);
      if (callback) callback();
    }
  }
  
  chooseResponsesToSave(callback) {
    if (this.capturedResponses.length === 0) {
      console.log(getColor('warning')('\n⚠️  No responses to save.\n'));
      if (callback) callback();
      return;
    }
    
    const readline = require('readline');
    const fs = require('fs');
    const path = require('path');
    const tty = require('tty');
    
    try {
      // Use /dev/tty for input/output
      const fd = fs.openSync('/dev/tty', 'r+');
      const ttyInput = new tty.ReadStream(fd);
      const ttyOutput = new tty.WriteStream(fd);
      
      // Show list of responses
      ttyOutput.write(getColor('success')(`\n📦 Captured ${this.capturedResponses.length} response(s):\n\n`));
      this.capturedResponses.forEach((resp, idx) => {
        ttyOutput.write(getColor('prompt')(`  [${idx + 1}] `) + 
                    getColor('info')(`${resp.request.method} ${resp.request.url}\n`));
        ttyOutput.write(getColor('dim')(`      Status: ${resp.response.statusCode} | ${resp.timestamp}\n`));
      });
      
      // Tab completion function for file paths
      const completer = FileManager.createPathCompleter();
      
      const rl = readline.createInterface({
        input: ttyInput,
        output: ttyOutput,
        completer: completer,
        terminal: true
      });
      
      rl.question(getColor('prompt')('\n📝 Enter response numbers to save (comma-separated, e.g., 1,3,5 or "all"): '), (input) => {
        const trimmed = input.trim().toLowerCase();
        
        let responsesToSave = [];
        
        if (trimmed === 'all' || trimmed === '') {
          responsesToSave = this.capturedResponses;
        } else {
          const numbers = trimmed.split(',').map(n => parseInt(n.trim(), 10));
          responsesToSave = numbers
            .filter(n => n >= 1 && n <= this.capturedResponses.length)
            .map(n => this.capturedResponses[n - 1]);
        }
        
        if (responsesToSave.length === 0) {
          ttyOutput.write(getColor('warning')('\n⚠️  No valid responses selected.\n'));
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          if (callback) callback();
          return;
        }
        
        // If multiple responses, ask if single file or individual files
        if (responsesToSave.length > 1) {
          rl.question(getColor('prompt')(`\n💾 Save as [s]ingle file or [i]ndividual files? (default: single): `), (choice) => {
            const saveMode = choice.trim().toLowerCase();
            
            if (saveMode === 'i' || saveMode === 'individual') {
              // Individual files mode
              rl.close();
              ttyInput.destroy();
              ttyOutput.destroy();
              this.saveIndividualResponses(responsesToSave, callback);
            } else {
              // Single file mode (default)
              this.promptSavePath(responsesToSave, ttyInput, ttyOutput, rl, callback);
            }
          });
        } else {
          // Single response, just save it
          this.promptSavePath(responsesToSave, ttyInput, ttyOutput, rl, callback);
        }
      });
    } catch (error) {
      console.error('Failed to open TTY for save:', error);
      if (callback) callback();
    }
  }
  
  promptSavePath(responsesToSave, ttyInput, ttyOutput, rl, callback) {
    const path = require('path');
    const fs = require('fs');
    
    const defaultFilename = 'captured-responses.json';
    ttyOutput.write(getColor('info')(`💡 Tip: Press Tab for autocomplete\n`));
    
    rl.question(getColor('prompt')(`\n💾 Save as (default: ${defaultFilename} in current directory): `), (savePath) => {
          let finalPath = savePath.trim();
          
          // If empty, use default filename in current directory
          if (!finalPath) {
            finalPath = path.join(process.cwd(), defaultFilename);
          } else {
            // Expand tilde to home directory
            if (finalPath.startsWith('~/')) {
              const os = require('os');
              finalPath = path.join(os.homedir(), finalPath.slice(2));
            }
            
            // If relative path, resolve from current directory
            if (!path.isAbsolute(finalPath)) {
              finalPath = path.resolve(process.cwd(), finalPath);
            }
            
            // If it's a directory, append default filename
            try {
              const stats = fs.statSync(finalPath);
              if (stats.isDirectory()) {
                finalPath = path.join(finalPath, defaultFilename);
              }
            } catch (err) {
              // File doesn't exist, that's fine - we'll create it
            }
          }
          
          try {
            fs.writeFileSync(finalPath, JSON.stringify(responsesToSave, null, 2), 'utf8');
            ttyOutput.write(getColor('success')(`\n✓ Saved ${responsesToSave.length} response(s) to: ${finalPath}\n`));
          } catch (err) {
            ttyOutput.write(getColor('error')(`\n❌ Failed to save responses: ${err.message}\n`));
          }
          
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          if (callback) callback();
        });
  }
  
  saveIndividualResponses(responsesToSave, callback) {
    const readline = require('readline');
    const fs = require('fs');
    const path = require('path');
    const tty = require('tty');
    
    try {
      const fd = fs.openSync('/dev/tty', 'r+');
      const ttyInput = new tty.ReadStream(fd);
      const ttyOutput = new tty.WriteStream(fd);
      
      // Tab completion function for file paths
      const completer = FileManager.createPathCompleter();
      
      const rl = readline.createInterface({
        input: ttyInput,
        output: ttyOutput,
        completer: completer,
        terminal: true
      });
      
      ttyOutput.write(getColor('info')(`💡 Tip: Press Tab for autocomplete\n`));
      
      rl.question(getColor('prompt')(`\n📁 Directory to save files (default: current directory): `), (dirPath) => {
        let saveDir = dirPath.trim();
        
        // If empty, use current directory
        if (!saveDir) {
          saveDir = process.cwd();
        } else {
          // Expand tilde
          if (saveDir.startsWith('~/')) {
            const os = require('os');
            saveDir = path.join(os.homedir(), saveDir.slice(2));
          }
          
          // Resolve relative paths
          if (!path.isAbsolute(saveDir)) {
            saveDir = path.resolve(process.cwd(), saveDir);
          }
        }
        
        // Create directory if it doesn't exist
        try {
          if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
          }
        } catch (err) {
          ttyOutput.write(getColor('error')(`\n❌ Failed to create directory: ${err.message}\n`));
          rl.close();
          ttyInput.destroy();
          ttyOutput.destroy();
          if (callback) callback();
          return;
        }
        
        // Save each response as a separate file
        let savedCount = 0;
        const errors = [];
        
        responsesToSave.forEach((resp, idx) => {
          // Generate filename from URL and timestamp
          const url = new URL(resp.request.url);
          const sanitizedPath = url.pathname.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
          const timestamp = new Date(resp.timestamp).getTime();
          const filename = `${resp.request.method.toLowerCase()}_${sanitizedPath}_${timestamp}.json`;
          const filepath = path.join(saveDir, filename);
          
          try {
            fs.writeFileSync(filepath, JSON.stringify(resp, null, 2), 'utf8');
            savedCount++;
            ttyOutput.write(getColor('dim')(`  ✓ Saved: ${filename}\n`));
          } catch (err) {
            errors.push(`${filename}: ${err.message}`);
          }
        });
        
        if (savedCount > 0) {
          ttyOutput.write(getColor('success')(`\n✓ Saved ${savedCount} file(s) to: ${saveDir}\n`));
        }
        
        if (errors.length > 0) {
          ttyOutput.write(getColor('error')(`\n❌ Failed to save ${errors.length} file(s):\n`));
          errors.forEach(err => ttyOutput.write(getColor('error')(`  ${err}\n`)));
        }
        
        rl.close();
        ttyInput.destroy();
        ttyOutput.destroy();
        if (callback) callback();
      });
    } catch (error) {
      console.error('Failed to open TTY for save:', error);
      if (callback) callback();
    }
  }
  
  handleHttpRequest(clientReq, clientRes) {
    const parsedUrl = url.parse(clientReq.url);
    
    // Capture request body
    let requestBody = '';
    clientReq.on('data', (chunk) => {
      requestBody += chunk;
    });
    
    clientReq.on('end', () => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path,
        method: clientReq.method,
        headers: clientReq.headers
      };

      // Remove proxy-specific headers
      delete options.headers['proxy-connection'];

      const proxyReq = http.request(options, (proxyRes) => {
        // Capture response body
        let responseBody = '';
        proxyRes.on('data', (chunk) => {
          responseBody += chunk;
        });

        proxyRes.on('end', () => {
          // Try to parse as JSON
          const contentType = proxyRes.headers['content-type'] || '';
          if (contentType.includes('application/json') || contentType.includes('text/json')) {
            // Check response size - skip very large responses
            const responseSizeMB = responseBody.length / (1024 * 1024);
            if (responseSizeMB > 25) {
              console.log(getColor('warning')(`\n⚠️  Response too large (${responseSizeMB.toFixed(2)} MB) - skipping JSON parse`));
              console.log(getColor('info')(`  URL: ${clientReq.url}`));
              console.log(getColor('dim')(`  Tip: Use --cli mode or save to file for large responses\n`));
              return;
            }
            
            try {
              const responseData = JSON.parse(responseBody);
              
              // Parse request body if present
              let requestData = null;
              if (requestBody) {
                try {
                  requestData = JSON.parse(requestBody);
                } catch (e) {
                  requestData = requestBody; // Keep as string if not JSON
                }
              }
              
              const capturedResponse = {
                request: {
                  url: clientReq.url,
                  method: clientReq.method,
                  headers: clientReq.headers,
                  body: requestData
                },
                response: {
                  statusCode: proxyRes.statusCode,
                  headers: proxyRes.headers,
                  body: responseData
                },
                timestamp: new Date().toISOString()
              };

              // Limit captured responses to prevent memory issues
              this.capturedResponses.push(capturedResponse);
              if (this.capturedResponses.length > this.maxCapturedResponses) {
                const removed = this.capturedResponses.shift();
                console.log(getColor('dim')(`  → Removed oldest response (limit: ${this.maxCapturedResponses})`));
              }
              
              console.log(getColor('success')(`\n✓ Captured JSON response from ${clientReq.method} ${clientReq.url}`));
              console.log(getColor('info')(`  Status: ${proxyRes.statusCode}`));
              console.log(getColor('info')(`  Size: ${responseBody.length} bytes`));
              console.log(getColor('prompt')(`  Response #${this.capturedResponses.length} - Type '${this.capturedResponses.length}' to analyze\n`));

              // Notify callback if provided
              if (this.onResponseCaptured) {
                this.onResponseCaptured(capturedResponse, this.capturedResponses.length);
              }
            } catch (e) {
              // Not valid JSON, ignore
            }
          }
        });

        // Forward response to client
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      });

      proxyReq.on('error', (err) => {
        console.error(getColor('error')(`\n❌ Proxy request error: ${err.message}`));
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end('Bad Gateway');
      });

      // Write request body to proxy request
      if (requestBody) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    });
  }

  handleHttpsConnect(req, clientSocket, head) {
    const { hostname, port } = this.parseConnectRequest(req.url);

    if (this.insecure && this.certManager) {
      // MITM mode - decrypt and inspect HTTPS
      this.handleHttpsMITM(req, clientSocket, head, hostname, port || 443);
    } else {
      // Regular tunneling mode - just pass through
      this.handleHttpsTunnel(clientSocket, hostname, port || 443);
    }
  }

  handleHttpsTunnel(clientSocket, hostname, port) {
    // Connect to the target server
    const serverSocket = net.connect(port, hostname, () => {
      // Tell the client the connection is established
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      
      // Pipe data between client and server
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      console.log(getColor('dim')(`  → HTTPS tunnel: ${hostname}:${port}`));
    });

    serverSocket.on('error', (err) => {
      console.error(getColor('error')(`\n❌ HTTPS tunnel error for ${hostname}: ${err.message}`));
      clientSocket.end();
    });

    clientSocket.on('error', (err) => {
      serverSocket.end();
    });
  }

  handleHttpsMITM(req, clientSocket, head, hostname, port) {
    // Generate certificate for this hostname
    const certData = this.certManager.generateCertForHost(hostname);
    
    // Tell client the connection is established
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    
    // Create TLS server to decrypt client's traffic
    const tlsOptions = {
      key: certData.key,
      cert: certData.cert,
      SNICallback: (servername, cb) => {
        const cert = this.certManager.generateCertForHost(servername);
        cb(null, tls.createSecureContext({
          key: cert.key,
          cert: cert.cert
        }));
      }
    };
    
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      server: this.server,
      ...tlsOptions
    });
    
    // Use http.Server to properly parse HTTP requests from decrypted TLS
    const httpServer = http.createServer((clientReq, clientRes) => {
      // Capture request body
      let requestBody = '';
      clientReq.on('data', (chunk) => {
        requestBody += chunk;
      });
      
      clientReq.on('end', () => {
        // Now we have properly parsed HTTP request
        const options = {
          hostname: hostname,
          port: port,
          path: clientReq.url,
          method: clientReq.method,
          headers: clientReq.headers,
          rejectUnauthorized: false // Accept self-signed certs on target
        };
        
        // Remove proxy-specific headers
        delete options.headers['proxy-connection'];
        
        const proxyReq = https.request(options, (proxyRes) => {
        // Determine if we should capture this response
        const contentType = proxyRes.headers['content-type'] || '';
        const shouldCapture = contentType.includes('application/json') || 
                              contentType.includes('text/json') ||
                              contentType.includes('json'); // Catch any JSON content type
        
        console.log(getColor('dim')(`  → Response: ${proxyRes.statusCode} ${contentType} (capture: ${shouldCapture})`));
        
        if (shouldCapture) {
          // Handle compressed responses
          const encoding = proxyRes.headers['content-encoding'];
          let responseStream = proxyRes;
          
          if (encoding === 'gzip') {
            responseStream = proxyRes.pipe(zlib.createGunzip());
          } else if (encoding === 'deflate') {
            responseStream = proxyRes.pipe(zlib.createInflate());
          } else if (encoding === 'br') {
            responseStream = proxyRes.pipe(zlib.createBrotliDecompress());
          }
          
          // Collect decompressed body
          const chunks = [];
          responseStream.on('data', (chunk) => {
            chunks.push(chunk);
          });
          
          responseStream.on('end', () => {
            const responseBody = Buffer.concat(chunks).toString('utf8');
            
            // Check response size - skip very large responses
            const responseSizeMB = responseBody.length / (1024 * 1024);
            if (responseSizeMB > 25) {
              console.log(getColor('warning')(`\n⚠️  Response too large (${responseSizeMB.toFixed(2)} MB) - skipping JSON parse`));
              console.log(getColor('info')(`  URL: https://${hostname}${clientReq.url}`));
              console.log(getColor('dim')(`  Tip: Use --cli mode or save to file for large responses\n`));
              return;
            }
            
            // Try to parse as JSON
            try {
              const responseData = JSON.parse(responseBody);
              
              // Parse request body if present
              let requestData = null;
              if (requestBody) {
                try {
                  requestData = JSON.parse(requestBody);
                } catch (e) {
                  requestData = requestBody; // Keep as string if not JSON
                }
              }
              
              const capturedResponse = {
                request: {
                  url: `https://${hostname}${clientReq.url}`,
                  method: clientReq.method,
                  headers: clientReq.headers,
                  body: requestData
                },
                response: {
                  statusCode: proxyRes.statusCode,
                  headers: proxyRes.headers,
                  body: responseData
                },
                timestamp: new Date().toISOString()
              };
              
              // Limit captured responses to prevent memory issues
              this.capturedResponses.push(capturedResponse);
              if (this.capturedResponses.length > this.maxCapturedResponses) {
                const removed = this.capturedResponses.shift();
                console.log(getColor('dim')(`  → Removed oldest response (limit: ${this.maxCapturedResponses})`));
              }
              
              console.log(getColor('success')(`\n✓ Captured HTTPS JSON response from ${clientReq.method} https://${hostname}${clientReq.url}`));
              console.log(getColor('info')(`  Status: ${proxyRes.statusCode}`));
              console.log(getColor('info')(`  Size: ${responseBody.length} bytes`));
              console.log(getColor('prompt')(`  Response #${this.capturedResponses.length} - Type '${this.capturedResponses.length}' to analyze\n`));
              
              if (this.onResponseCaptured) {
                this.onResponseCaptured(capturedResponse, this.capturedResponses.length);
              }
            } catch (e) {
              console.log(getColor('warning')(`  ⚠️  Failed to parse JSON from ${hostname}: ${e.message}`));
              console.log(getColor('dim')(`     Content-Type: ${contentType}`));
              console.log(getColor('dim')(`     Body preview: ${responseBody.substring(0, 100)}...`));
            }
          });
          
          responseStream.on('error', (err) => {
            console.log(getColor('error')(`  ❌ Decompression error: ${err.message}`));
          });
        }
        
          // Forward response to client (properly)
          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(clientRes);
        });
        
        proxyReq.on('error', (err) => {
          console.error(getColor('error')(`\n❌ HTTPS proxy error for ${hostname}: ${err.message}`));
          clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
          clientRes.end('Bad Gateway');
        });
        
        // Write request body to proxy request
        if (requestBody) {
          proxyReq.write(requestBody);
        }
        proxyReq.end();
      });
    });
    
    // Emit the decrypted connection to the HTTP server
    httpServer.emit('connection', tlsSocket);
    
    tlsSocket.on('error', (err) => {
      console.error(getColor('error')(`\n❌ TLS error for ${hostname}: ${err.message}`));
    });
    
    console.log(getColor('info')(`  → HTTPS MITM: ${hostname}:${port} (inspecting)`));
  }

  parseConnectRequest(urlString) {
    const [hostname, port] = urlString.split(':');
    return { hostname, port: parseInt(port, 10) };
  }

  getResponse(index) {
    if (index < 1 || index > this.capturedResponses.length) {
      return null;
    }
    return this.capturedResponses[index - 1];
  }

  listResponses() {
    if (this.capturedResponses.length === 0) {
      console.log(getColor('info')('\n📭 No responses captured yet\n'));
      return;
    }

    console.log(getColor('success')(`\n📦 Captured ${this.capturedResponses.length} response(s):\n`));
    this.capturedResponses.forEach((resp, idx) => {
      console.log(getColor('prompt')(`  [${idx + 1}] `) + 
                  getColor('info')(`${resp.request.method} ${resp.request.url}`));
      console.log(getColor('dim')(`      Status: ${resp.response.statusCode} | ${resp.timestamp}`));
    });
    console.log(getColor('info')(`\nType 'jojq <number>' to analyze a response\n`));
  }

  stop() {
    if (this.server) {
      this.server.close(() => {
        console.log(getColor('success')('\n✓ Proxy server stopped\n'));
      });
    }
  }
}

module.exports = { ProxyServer };

