const fs = require('fs');
const pathModule = require('path');
const os = require('os');

/**
 * Keybindings Manager
 * Handles custom keybindings for commands with ability to reset to defaults
 */
class KeybindingsManager {
  constructor() {
    this.configPath = pathModule.join(os.homedir(), '.jojqrc');
    this.keybindingsPath = pathModule.join(os.homedir(), '.jojq-keybindings.json');
    
    // Default keybindings for commands
    // Format: { command: ['key1', 'key2', ...] }
    this.defaultKeybindings = {
      // Commands
      'help': [':help', ':h', '?'],
      'show': [':show'],
      'paths': [':paths'],
      'copy': [':copy', ':c'],
      'copy-query': [':copy-query', ':cq'],
      'copy-results': [':copy-results', ':cr'],
      'raw': [':raw'],
      'decode': [':decode'],
      'parse': [':parse'],
      'save': [':save'],
      'saveline': [':saveline', ':sl'],
      'dump': [':dump', ':export'],
      'exit': [':exit', ':quit', ':q'],
      
      // Search
      'search': ['/'],
      'search-in-result': ['//'],
      
      // Navigation
      'next-page': ['n'],
      'prev-page': ['p'],
      
      // Text editing (non-command shortcuts)
      'delete-word-backward': ['C-w', 'M-backspace'],
      'clear-line': ['C-u', 'C-c'],
      'delete-to-end': ['C-k'],
      'move-start': ['C-a'],
      'move-end': ['C-e'],
      'insert-wildcard': ['C-*', 'M-*'],
      
      // Panel navigation
      'switch-to-results': ['right', 'C-d'],
      'switch-to-input': ['left', 'C-i', 'escape'],
      'toggle-help': ['f1'],
      
      // Autocomplete
      'autocomplete': ['tab']
    };
    
    // Current keybindings (loaded from file or defaults)
    this.keybindings = {};
    
    // Reverse mapping: key -> command
    this.keyToCommand = {};
  }
  
  /**
   * Load keybindings from config file or use defaults
   */
  loadKeybindings() {
    try {
      if (fs.existsSync(this.keybindingsPath)) {
        const data = fs.readFileSync(this.keybindingsPath, 'utf8');
        const custom = JSON.parse(data);
        
        // Merge custom with defaults (custom overrides)
        this.keybindings = { ...this.defaultKeybindings, ...custom };
      } else {
        // Use defaults
        this.keybindings = { ...this.defaultKeybindings };
      }
      
      // Build reverse mapping
      this.buildReverseMapping();
      
      return this.keybindings;
    } catch (error) {
      console.error('Error loading keybindings, using defaults:', error.message);
      this.keybindings = { ...this.defaultKeybindings };
      this.buildReverseMapping();
      return this.keybindings;
    }
  }
  
  /**
   * Save custom keybindings to config file
   */
  saveKeybindings(customKeybindings) {
    try {
      // Only save non-default keybindings (customizations)
      const toSave = {};
      
      for (const [command, keys] of Object.entries(customKeybindings)) {
        const defaultKeys = this.defaultKeybindings[command] || [];
        const customKeys = keys || [];
        
        // Check if keys differ from defaults
        const isDifferent = 
          customKeys.length !== defaultKeys.length ||
          !customKeys.every((key, idx) => key === defaultKeys[idx]);
        
        if (isDifferent) {
          toSave[command] = customKeys;
        }
      }
      
      fs.writeFileSync(
        this.keybindingsPath,
        JSON.stringify(toSave, null, 2),
        'utf8'
      );
      
      this.keybindings = { ...this.defaultKeybindings, ...toSave };
      this.buildReverseMapping();
      
      return true;
    } catch (error) {
      console.error('Error saving keybindings:', error.message);
      return false;
    }
  }
  
  /**
   * Reset all keybindings to defaults
   */
  resetToDefaults() {
    try {
      if (fs.existsSync(this.keybindingsPath)) {
        fs.unlinkSync(this.keybindingsPath);
      }
      
      this.keybindings = { ...this.defaultKeybindings };
      this.buildReverseMapping();
      
      return true;
    } catch (error) {
      console.error('Error resetting keybindings:', error.message);
      return false;
    }
  }
  
  /**
   * Reset a specific command to default keybindings
   */
  resetCommand(command) {
    if (!this.defaultKeybindings[command]) {
      return false;
    }
    
    const custom = this.getCustomKeybindings();
    delete custom[command];
    
    return this.saveKeybindings({ ...this.defaultKeybindings, ...custom });
  }
  
  /**
   * Get keybindings for a specific command
   */
  getKeybindings(command) {
    return this.keybindings[command] || [];
  }
  
  /**
   * Get all keybindings
   */
  getAllKeybindings() {
    return { ...this.keybindings };
  }
  
  /**
   * Get only custom (non-default) keybindings
   */
  getCustomKeybindings() {
    const custom = {};
    
    for (const [command, keys] of Object.entries(this.keybindings)) {
      const defaultKeys = this.defaultKeybindings[command] || [];
      const customKeys = keys || [];
      
      const isDifferent = 
        customKeys.length !== defaultKeys.length ||
        !customKeys.every((key, idx) => key === defaultKeys[idx]);
      
      if (isDifferent) {
        custom[command] = customKeys;
      }
    }
    
    return custom;
  }
  
  /**
   * Set keybindings for a command
   */
  setKeybindings(command, keys) {
    if (!Array.isArray(keys)) {
      keys = [keys];
    }
    
    // Validate that keys don't conflict with other commands
    const conflicts = this.findConflicts(command, keys);
    if (conflicts.length > 0) {
      return { success: false, conflicts };
    }
    
    const allBindings = { ...this.keybindings, [command]: keys };
    const saved = this.saveKeybindings(allBindings);
    
    return { success: saved, conflicts: [] };
  }
  
  /**
   * Add a keybinding to a command (append to existing)
   */
  addKeybinding(command, key) {
    const existing = this.getKeybindings(command);
    
    if (existing.includes(key)) {
      return { success: true, conflicts: [] }; // Already exists
    }
    
    return this.setKeybindings(command, [...existing, key]);
  }
  
  /**
   * Remove a keybinding from a command
   */
  removeKeybinding(command, key) {
    const existing = this.getKeybindings(command);
    const filtered = existing.filter(k => k !== key);
    
    if (filtered.length === 0) {
      return { success: false, error: 'Cannot remove last keybinding for command' };
    }
    
    return this.setKeybindings(command, filtered);
  }
  
  /**
   * Find which command a key is bound to
   */
  getCommandForKey(key) {
    return this.keyToCommand[key] || null;
  }
  
  /**
   * Check if a key is bound to any command
   */
  isKeyBound(key) {
    return key in this.keyToCommand;
  }
  
  /**
   * Find conflicts if we were to bind keys to a command
   */
  findConflicts(excludeCommand, keys) {
    const conflicts = [];
    
    for (const key of keys) {
      const boundTo = this.keyToCommand[key];
      if (boundTo && boundTo !== excludeCommand) {
        conflicts.push({ key, command: boundTo });
      }
    }
    
    return conflicts;
  }
  
  /**
   * Build reverse mapping (key -> command)
   */
  buildReverseMapping() {
    this.keyToCommand = {};
    
    for (const [command, keys] of Object.entries(this.keybindings)) {
      for (const key of keys) {
        this.keyToCommand[key] = command;
      }
    }
  }
  
  /**
   * Get a formatted string of all keybindings (for display)
   */
  formatKeybindings(showDefaults = false) {
    const lines = [];
    const categories = {
      'Commands': ['help', 'show', 'paths', 'copy', 'copy-query', 'copy-results', 'raw', 'decode', 'parse', 'save', 'saveline', 'dump', 'exit'],
      'Search': ['search', 'search-in-result'],
      'Navigation': ['next-page', 'prev-page', 'switch-to-results', 'switch-to-input', 'toggle-help'],
      'Text Editing': ['delete-word-backward', 'clear-line', 'delete-to-end', 'move-start', 'move-end', 'insert-wildcard'],
      'Autocomplete': ['autocomplete']
    };
    
    for (const [category, commands] of Object.entries(categories)) {
      lines.push(`\n${category}:`);
      
      for (const command of commands) {
        const keys = this.keybindings[command] || [];
        const defaultKeys = this.defaultKeybindings[command] || [];
        const isCustom = JSON.stringify(keys) !== JSON.stringify(defaultKeys);
        
        if (keys.length > 0) {
          const keyStr = keys.map(k => `"${k}"`).join(', ');
          const marker = isCustom ? ' [CUSTOM]' : (showDefaults ? ' [default]' : '');
          lines.push(`  ${command.padEnd(20)} ${keyStr}${marker}`);
        }
      }
    }
    
    return lines.join('\n');
  }
  
  /**
   * Export keybindings to a file (for backup/sharing)
   */
  exportKeybindings(filepath) {
    try {
      const data = {
        version: '1.0',
        keybindings: this.keybindings,
        exported: new Date().toISOString()
      };
      
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Error exporting keybindings:', error.message);
      return false;
    }
  }
  
  /**
   * Import keybindings from a file
   */
  importKeybindings(filepath) {
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      
      if (!data.keybindings) {
        throw new Error('Invalid keybindings file format');
      }
      
      return this.saveKeybindings(data.keybindings);
    } catch (error) {
      console.error('Error importing keybindings:', error.message);
      return false;
    }
  }
}

module.exports = { KeybindingsManager };

