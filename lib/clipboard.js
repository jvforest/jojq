#!/usr/bin/env node

const { spawn } = require('child_process');
const os = require('os');

// ============= CLIPBOARD MANAGER =============

/**
 * ClipboardManager - Handles clipboard operations across platforms
 * 
 * @class
 * @description Provides unified clipboard copy functionality for macOS, Linux, and Windows
 */
class ClipboardManager {
  /**
   * Get the clipboard command for the current platform
   * 
   * @static
   * @returns {{cmd: string, args: string[]} | null} Command and arguments, or null if unsupported
   */
  static getCopyCommand() {
    const platform = os.platform();
    
    if (platform === 'darwin') {
      return { cmd: 'pbcopy', args: [] };
    }
    
    if (platform === 'linux') {
      return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
    }
    
    if (platform === 'win32') {
      return { cmd: 'clip', args: [] };
    }
    
    return null;
  }

  /**
   * Check if clipboard is supported on this platform
   * 
   * @static
   * @returns {boolean} True if clipboard is supported
   */
  static isSupported() {
    return this.getCopyCommand() !== null;
  }

  /**
   * Copy text to clipboard
   * 
   * @static
   * @param {string} text - Text to copy to clipboard
   * @returns {Promise<void>} Resolves when copy succeeds, rejects on error
   */
  static async copyToClipboard(text) {
    const command = this.getCopyCommand();
    
    if (!command) {
      throw new Error('Clipboard not supported on this platform');
    }
    
    return new Promise((resolve, reject) => {
      const proc = spawn(command.cmd, command.args);
      
      let errorOutput = '';
      
      proc.stdin.write(text);
      proc.stdin.end();
      
      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Copy command exited with code ${code}: ${errorOutput.trim() || 'Unknown error'}`));
        }
      });
      
      proc.on('error', (error) => {
        reject(new Error(`Failed to execute copy command: ${error.message}`));
      });
    });
  }
}

module.exports = { ClipboardManager };

