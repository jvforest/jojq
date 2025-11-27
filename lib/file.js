#!/usr/bin/env node

const fs = require('fs');
const pathModule = require('path');
const os = require('os');
const { getColor } = require('./config');

// ============= FILE MANAGER =============
class FileManager {
  static saveToFile(data, filename = null, prefix = 'jojq-result') {
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      filename = `${prefix}-${timestamp}-${Date.now()}.json`;
    }
    
    if (!filename.endsWith('.json')) {
      filename += '.json';
    }
    
    const desktopPath = pathModule.join(os.homedir(), 'Desktop');
    const fullPath = pathModule.join(desktopPath, filename);
    
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf8');
    return fullPath;
  }
  
  static findLineNumber(fullJSON, path, QueryExecutor) {
    if (!path) return null;
    
    try {
      // Execute the path to get the actual value
      const result = QueryExecutor.execute(path);
      if (!result.success) return null;
      
      const targetValue = result.data;
      
      // Get the pretty-printed full JSON
      const prettyJSON = JSON.stringify(fullJSON, null, 2);
      const lines = prettyJSON.split('\n');
      
      // Extract the last key from the path to search for the pattern
      const keyMatch = path.match(/[.\[]'?([^.\[']+)'?\]?$/);
      if (!keyMatch) return null;
      
      const searchKey = keyMatch[1];
      
      // Convert target value to string for comparison
      const targetStr = typeof targetValue === 'string' 
        ? `"${targetValue}"` 
        : JSON.stringify(targetValue);
      
      // Search for lines that contain both the key AND the value
      // This makes it more specific and avoids false matches
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // For simple values, look for "key": value pattern
        if (typeof targetValue !== 'object' || targetValue === null) {
          if (line.includes(`"${searchKey}": ${targetStr}`)) {
            return i + 1; // Line numbers are 1-based
          }
        } else {
          // For objects/arrays, just find the key line
          // since the value spans multiple lines
          if (line.includes(`"${searchKey}":`)) {
            return i + 1;
          }
        }
      }
      
      return null;
    } catch (e) {
      return null;
    }
  }
  
  /**
   * Create a path completer function for readline tab completion
   * Used for file path autocomplete in proxy save operations
   * 
   * @static
   * @returns {Function} Completer function for readline interface
   */
  static createPathCompleter() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    return (line) => {
      let searchPath = line;
      
      // Expand tilde to home directory
      if (searchPath.startsWith('~/')) {
        searchPath = path.join(os.homedir(), searchPath.slice(2));
      }
      
      // If empty, use current directory
      if (!searchPath) {
        searchPath = '.';
      }
      
      const dir = path.dirname(searchPath);
      const base = path.basename(searchPath);
      
      try {
        const files = fs.readdirSync(dir);
        const hits = files
          .filter(f => f.startsWith(base))
          .map(f => {
            const fullPath = path.join(dir, f);
            // Add trailing slash for directories
            try {
              return fs.statSync(fullPath).isDirectory() ? f + '/' : f;
            } catch (e) {
              return f;
            }
          });
        
        // Return matches - if only one match, complete it
        const completions = hits.map(h => path.join(dir, h));
        return [completions.length ? completions : [line], line];
      } catch (e) {
        return [[], line];
      }
    };
  }
}

module.exports = { FileManager };

