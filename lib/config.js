#!/usr/bin/env node

const fs = require('fs');
const pathModule = require('path');
const os = require('os');
const chalk = require('chalk');

// ============= COLOR SCHEME =============
// Using a single, clean color palette
const COLORS = {
  prompt: chalk.magenta,
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
  highlight: chalk.cyan.bold,
  dim: chalk.gray,
  path: chalk.cyan,
  
  // JSON syntax highlighting
  jsonKey: chalk.blue,
  jsonString: chalk.green,
  jsonNumber: chalk.yellow,
  jsonBoolean: chalk.magenta,
  jsonNull: chalk.gray
};

// ============= CONFIGURATION MANAGER =============
class ConfigManager {
  static loadConfig() {
    const defaultConfig = {
      historySize: 50,
      maxSuggestions: 15,
      previewLines: 3
    };

    // Try current directory first, then home directory
    // Handle case where current directory doesn't exist
    let currentDir;
    try {
      currentDir = process.cwd();
    } catch (e) {
      currentDir = os.homedir(); // Fallback to home if cwd fails
    }
    
    const configPaths = [
      pathModule.join(currentDir, '.jojqrc'),
      pathModule.join(os.homedir(), '.jojqrc')
    ];

    for (const configPath of configPaths) {
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const userConfig = JSON.parse(configContent);
        return { ...defaultConfig, ...userConfig };
      } catch (e) {
        // Config file not found or invalid, continue to next path
        continue;
      }
    }

    // No config file found, return defaults
    return defaultConfig;
  }
}

// ============= COLOR HELPERS =============
/**
 * Get a color function for the given type
 * @param {string} type - Color type (e.g., 'success', 'error', 'info')
 * @returns {Function} Chalk color function
 */
function getColor(type) {
  return COLORS[type] || chalk.white;
}

module.exports = {
  ConfigManager,
  getColor
};
