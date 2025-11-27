#!/usr/bin/env node

const fuzzysort = require('fuzzysort');
const { getColor } = require('./config');
const { Formatter, TextUtils } = require('./formatter');
const { FileManager } = require('./file');

// ============= COMMAND HANDLER =============
class CommandHandler {
  static COMMANDS = {
    help: ['help', 'h'],
    paths: ['paths', 'p'],
    show: ['show', 's', 'raw', 'json'],
    save: ['save'],
    saveline: ['saveline', 'sl'],
    dump: ['dump', 'export'],
    decode: ['decode', 'd'],
    parse: ['parse', 'pj'],
    copy: ['copy', 'c'],
    copyQuery: ['copy-query', 'cq'],
    copyResults: ['copy-results', 'cr'],
    exit: ['exit', 'quit', 'q']
  };
  
  constructor(appState, QueryExecutor) {
    this.appState = appState;
    this.QueryExecutor = QueryExecutor;
  }
  
  static getCommandSuggestions(query) {
    const allCommands = Object.values(CommandHandler.COMMANDS)
      .flat()
      .map(c => ':' + c);
    
    if (!query) {
      return allCommands.map(cmd => ({ path: cmd, score: 0 }));
    }
    
    const results = fuzzysort.go(query, allCommands.map(c => c.substring(1)));
    return results.map(r => ({ path: ':' + r.target, score: r.score }));
  }
  
  handle(cmd, args, output) {
    cmd = cmd.toLowerCase();
    
    if (CommandHandler.COMMANDS.exit.includes(cmd)) {
      return { action: 'exit' };
    }
    
    if (CommandHandler.COMMANDS.help.includes(cmd)) {
      return this.handleHelp(output);
    }
    
    if (CommandHandler.COMMANDS.show.includes(cmd)) {
      return this.handleShow(output);
    }
    
    if (CommandHandler.COMMANDS.paths.includes(cmd)) {
      return this.handlePaths(output);
    }
    
    if (CommandHandler.COMMANDS.save.includes(cmd)) {
      return this.handleSave(args, output);
    }
    
    if (CommandHandler.COMMANDS.saveline.includes(cmd)) {
      return this.handleSaveLine(args, output);
    }
    
    if (CommandHandler.COMMANDS.dump.includes(cmd)) {
      return this.handleDump(args, output);
    }
    
    if (CommandHandler.COMMANDS.decode.includes(cmd)) {
      return this.handleDecode(output);
    }
    
    if (CommandHandler.COMMANDS.parse.includes(cmd)) {
      return this.handleParse(output);
    }
    
    output.write(getColor('error')('\n❌ Unknown command: ' + cmd + '\n'));
    output.write(getColor('info')('Type :help for available commands\n\n'));
    return { action: 'continue' };
  }
  
  handleHelp(output) {
    output.write(getColor('prompt')('\nAvailable commands:\n\n'));
    output.write(getColor('info')('  :help, :h            - show this help\n'));
    output.write(getColor('info')('  :paths, :p           - show all available paths\n'));
    output.write(getColor('info')('  :show, :s            - display full JSON\n'));
    output.write(getColor('info')('  :save [filename]     - save last result to JSON file\n'));
    output.write(getColor('info')('  :saveline [filename] - save result with line number\n'));
    output.write(getColor('info')('  :dump [filename]     - save entire JSON response\n'));
    output.write(getColor('info')('  :decode, :d          - decode URI-encoded strings\n'));
    output.write(getColor('info')('  :parse, :pj          - parse JSON strings\n'));
    output.write(getColor('info')('  :exit, :q            - quit jojq\n\n'));
    output.write(getColor('prompt')('Search:\n\n'));
    output.write(getColor('info')('  /searchterm          - find values containing "searchterm"\n\n'));
    output.write(getColor('prompt')('Available paths (first 20):\n\n'));
    this.appState.allPaths.slice(0, 20).forEach(p => {
      output.write(getColor('info')('  ' + p) + '\n');
    });
    if (this.appState.allPaths.length > 20) {
      output.write(getColor('info')(`  ... and ${this.appState.allPaths.length - 20} more (use :paths to see all)\n`));
    }
    output.write('\n');
    return { action: 'continue' };
  }
  
  handleShow(output) {
    this.appState.setLastResult(this.appState.jsonData, null);
    output.write(getColor('prompt')('\n📄 Raw JSON:\n\n'));
    output.write(Formatter.prettyPrint(this.appState.jsonData) + '\n\n');
    return { action: 'continue' };
  }
  
  handlePaths(output) {
    output.write(getColor('prompt')('\n📋 All available paths (' + this.appState.allPaths.length + '):\n\n'));
    this.appState.allPaths.forEach(p => {
      output.write(getColor('info')('  ' + p) + '\n');
    });
    output.write('\n');
    return { action: 'continue' };
  }
  
  handleSave(args, output) {
    if (this.appState.lastDisplayedResult === null) {
      output.write(getColor('error')('\n❌ No result to save. Query something first.\n\n'));
      return { action: 'continue' };
    }
    
    try {
      const fullPath = FileManager.saveToFile(this.appState.lastDisplayedResult, args, 'jojq-result');
      output.write(getColor('success')('\n✓ Saved result to: ') + getColor('prompt')(fullPath) + '\n\n');
    } catch (error) {
      output.write(getColor('error')('\n❌ Error saving file: ') + error.message + '\n\n');
    }
    return { action: 'continue' };
  }
  
  handleSaveLine(args, output) {
    if (this.appState.lastDisplayedResult === null) {
      output.write(getColor('error')('\n❌ No result to save. Query something first.\n\n'));
      return { action: 'continue' };
    }
    
    try {
      // Find the line number where this result appears in the full JSON
      const lineNumber = FileManager.findLineNumber(this.appState.jsonData, this.appState.lastDisplayedPath, this.QueryExecutor);
      
      if (!lineNumber) {
        output.write(getColor('warning')('\n⚠️  Could not determine line number for this path.\n'));
        output.write(getColor('info')('   Tip: Use :dump to save the full JSON without line reference.\n\n'));
        return { action: 'continue' };
      }
      
      // Prepend line number to filename
      let filename = args;
      const prefix = `line${lineNumber}`;
      filename = filename ? `${prefix}-${filename}` : `${prefix}-jojq-result`;
      
      // Save the FULL JSON (for context) with line number pointing to the selected value
      const fullPath = FileManager.saveToFile(this.appState.jsonData, filename, 'jojq-full');
      
      output.write(getColor('success')('\n✓ Saved full JSON to: ') + getColor('prompt')(fullPath) + '\n');
      output.write(getColor('info')(`   → Look at line ${lineNumber} for the selected value\n`));
      output.write(getColor('info')(`   → Path: ${this.appState.lastDisplayedPath}\n\n`));
    } catch (error) {
      output.write(getColor('error')('\n❌ Error saving file: ') + error.message + '\n\n');
    }
    return { action: 'continue' };
  }
  
  handleDump(args, output) {
    try {
      const fullPath = FileManager.saveToFile(this.appState.jsonData, args, 'jojq-full');
      output.write(getColor('success')('\n✓ Saved full JSON to: ') + getColor('prompt')(fullPath) + '\n\n');
    } catch (error) {
      output.write(getColor('error')('\n❌ Error saving file: ') + error.message + '\n\n');
    }
    return { action: 'continue' };
  }
  
  handleDecode(output) {
    if (this.appState.lastDisplayedResult === null) {
      output.write(getColor('error')('\n❌ No result to decode. Query something first.\n\n'));
      return { action: 'continue' };
    }
    
    try {
      const decoded = TextUtils.decodeURIData(this.appState.lastDisplayedResult);
      
      output.write(getColor('success')('\n✓ Decoded result:\n\n'));
      output.write(Formatter.prettyPrint(decoded) + '\n\n');
      
      // Update the last result to the decoded version
      this.appState.lastDisplayedResult = decoded;
    } catch (error) {
      output.write(getColor('error')('\n❌ Error decoding: ') + error.message + '\n\n');
    }
    return { action: 'continue' };
  }
  
  handleParse(output) {
    if (this.appState.lastDisplayedResult === null) {
      output.write(getColor('error')('\n❌ No result to parse. Query something first.\n\n'));
      return { action: 'continue' };
    }
    
    try {
      const parsed = TextUtils.parseJSONData(this.appState.lastDisplayedResult);
      
      output.write(getColor('success')('\n✓ Parsed JSON string:\n\n'));
      output.write(Formatter.prettyPrint(parsed) + '\n\n');
      
      // Update the last result to the parsed version
      this.appState.lastDisplayedResult = parsed;
    } catch (error) {
      output.write(getColor('error')('\n❌ Error parsing: ') + error.message + '\n\n');
    }
    return { action: 'continue' };
  }
}

module.exports = { CommandHandler };

