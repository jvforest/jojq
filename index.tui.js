#!/usr/bin/env node

const blessed = require('blessed');
const fs = require('fs');
const pathModule = require('path');
const os = require('os');
const { JSONPath } = require('jsonpath-plus');
const chalk = require('chalk');

// Import existing modules
const { AppState } = require('./lib/state');
const { PathExtractor } = require('./lib/path');
const { Formatter, TextUtils } = require('./lib/formatter');
const { FileManager } = require('./lib/file');
const { SearchEngine } = require('./lib/search');
const { QueryExecutor } = require('./lib/query');
const { CommandHandler } = require('./lib/commands');
const { ConfigManager } = require('./lib/config');
const { ProxyServer } = require('./lib/proxy');
const { ClipboardManager } = require('./lib/clipboard');
const { KeybindingsManager } = require('./lib/keybindings');
const { DisplayManager, TUI_COLORS } = require('./lib/tui/display');

// Initialize state
const appState = new AppState();
const config = ConfigManager.loadConfig();
const keybindingsManager = new KeybindingsManager();
keybindingsManager.loadKeybindings();

// Create TUI Application
class JojqTUI {
  constructor(preloadedJSON = null, proxyMode = false) {
    this.screen = null;
    this.infoBox = null;
    this.resultsBox = null;
    this.suggestionsBox = null;
    this.commandInput = null;
    this.suggestions = [];
    this.selectedIndex = 0;
    this.commandHistory = [];
    this.historyIndex = -1;
    this.focusedPanel = 'input'; // 'input', 'results', or 'suggestions'
    this.resultsSelectedIndex = 0;
    this.preloadedJSON = preloadedJSON;
    this.proxyMode = proxyMode; // If true, don't exit on Escape, let proxy handle it
    this.lastDisplayedType = null; // 'result', 'wildcard', 'search'
    this.lastWildcardResults = null; // Store wildcard results for copying
    this.lastQuery = null; // Store the last executed query
    this.lastDisplayedLabels = null; // Store the displayed labels for copy-results
    
    // Interactive prompt state for decode/parse
    this.waitingForPrompt = false;
    this.promptType = null; // 'parse' or 'decode'
    
    // Help visibility state
    this.helpVisible = false; // Track if help box is visible (F1 to toggle)
    
    // Search within result state
    this.searchMatches = []; // Array of line numbers where matches were found
    this.currentMatchIndex = 0; // Current match being viewed
    
    // Initialize search engine first, then query executor
    this.searchEngine = new SearchEngine(appState, CommandHandler);
    this.queryExecutor = new QueryExecutor(appState, this.searchEngine);
    
    // Initialize display manager
    this.displayManager = new DisplayManager(this, appState);
    
    // Performance optimizations for large files
    this.suggestionCache = new Map();
    this.MAX_CACHE_SIZE = 100; // Prevent unbounded cache growth (100 entries ≈ 100-500KB total)
    this.lastSuggestionInput = null; // Use null instead of '' to allow initial empty suggestions
    this.suggestionDebounceTimer = null;
  }
  
  // Helper to wrap text with blessed color tag
  wrapColor(text, type) {
    const colorTag = TUI_COLORS[type];
    if (!colorTag) {
      return text; // No color defined
    }
    return `{${colorTag}}${text}{/${colorTag}}`;
  }
  
  /**
   * Parse a JSONPath string back into an array
   * @param {string} pathString - Path like "$['field1']['field2'][0]['field3']"
   * @returns {Array} - Path array like ['$', 'field1', 'field2', 0, 'field3']
   */
  parsePathString(pathString) {
    const pathArray = ['$'];
    
    // Remove the leading $
    let remaining = pathString.substring(1);
    
    // Match patterns like ['field'], [0], .field
    const pattern = /\['([^']+)'\]|\[(\d+)\]|\.([a-zA-Z_$][\w$]*)/g;
    let match;
    
    while ((match = pattern.exec(remaining)) !== null) {
      if (match[1] !== undefined) {
        // Bracket notation with quotes: ['field']
        pathArray.push(match[1]);
      } else if (match[2] !== undefined) {
        // Array index: [0]
        pathArray.push(parseInt(match[2], 10));
      } else if (match[3] !== undefined) {
        // Dot notation: .field
        pathArray.push(match[3]);
      }
    }
    
    return pathArray;
  }
  
  /**
   * Parse query with optional pipe syntax for labels and filters
   * @param {string} query - Full query string (may contain | @label=... | @where=...)
   * @returns {object} - { mainQuery, labelQuery, whereFilter }
   */
  parseQueryWithLabel(query) {
    const pipeIndex = query.indexOf('|');
    if (pipeIndex === -1) {
      return { mainQuery: query.trim(), labelQuery: null, whereFilter: null };
    }
    
    const mainQuery = query.substring(0, pipeIndex).trim();
    const pipeParts = query.substring(pipeIndex + 1).trim();
    
    // Parse multiple pipe operators: | @label=... | @where=...
    let labelQuery = null;
    let whereFilter = null;
    
    // Split by pipe but handle escaped pipes or pipes in quotes
    const parts = pipeParts.split('|').map(p => p.trim());
    
    for (const part of parts) {
      // Check for @label
      const labelMatch = part.match(/^@label\s*=\s*(.+)$/);
      if (labelMatch) {
        labelQuery = labelMatch[1].trim();
        continue;
      }
      
      // Check for @where
      const whereMatch = part.match(/^@where\s*=\s*(.+)$/);
      if (whereMatch) {
        whereFilter = whereMatch[1].trim();
        continue;
      }
      
      // If no @ prefix, assume it's a label query (for backwards compatibility)
      if (!part.startsWith('@') && !labelQuery) {
        labelQuery = part;
      }
    }
    
    return { mainQuery, labelQuery, whereFilter };
  }
  
  /**
   * Evaluate a single condition (no AND/OR)
   * @param {*} itemValue - The result item value
   * @param {Array} itemPath - The JSONPath array for this item
   * @param {string} condition - Single condition (e.g., "status=active")
   * @returns {boolean} - True if condition matches
   */
  evaluateSingleCondition(itemValue, itemPath, condition) {
    if (!condition) {
      return true;
    }
    
    // Parse condition: field operator value
    const operators = ['>=', '<=', '!=', '=', '>', '<', 'contains'];
    let operator = null;
    let field = null;
    let value = null;
    
    for (const op of operators) {
      if (condition.includes(op)) {
        const parts = condition.split(op);
        if (parts.length === 2) {
          field = parts[0].trim();
          value = parts[1].trim();
          operator = op;
          break;
        }
      }
    }
    
    if (!field || !operator || value === null) {
      return true; // Invalid condition, don't filter
    }
    
    // Get field value from item
    let fieldValue;
    
    // Check if field is a relative path (starts with ../)
    if (field.startsWith('../') || field.startsWith('../../')) {
      // Resolve relative path and query for the value
      if (!itemPath || !Array.isArray(itemPath)) {
        return false; // Can't resolve relative path without itemPath
      }
      
      const absolutePath = this.resolveRelativePath(itemPath, field);
      const result = this.queryExecutor.execute(absolutePath);
      
      if (!result.success || result.data === undefined) {
        return false; // Relative path didn't resolve
      }
      
      fieldValue = result.data;
    } else if (itemValue && typeof itemValue === 'object') {
      // Direct field access on current object
      fieldValue = itemValue[field];
      if (fieldValue === undefined) {
        return false; // Field doesn't exist
      }
    } else {
      // Item is not an object and field is not relative - can't filter
      return false;
    }
    
    // Remove quotes from value if present
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    // Try to parse value as number if possible
    const numValue = parseFloat(value);
    const isNumber = !isNaN(numValue);
    
    // Evaluate condition
    switch (operator) {
      case '=':
      case '==':
        return isNumber ? fieldValue == numValue : String(fieldValue) === value;
      case '!=':
        return isNumber ? fieldValue != numValue : String(fieldValue) !== value;
      case '>':
        return isNumber && fieldValue > numValue;
      case '<':
        return isNumber && fieldValue < numValue;
      case '>=':
        return isNumber && fieldValue >= numValue;
      case '<=':
        return isNumber && fieldValue <= numValue;
      case 'contains':
        return String(fieldValue).toLowerCase().includes(value.toLowerCase());
      default:
        return true;
    }
  }
  
  /**
   * Evaluate a where filter condition with AND/OR support
   * @param {*} itemValue - The result item value (object or primitive)
   * @param {Array} itemPath - The JSONPath array for this item
   * @param {string} condition - The where condition (e.g., "status=active AND age>25")
   * @returns {boolean} - True if item matches condition
   */
  evaluateWhereCondition(itemValue, itemPath, condition) {
    if (!condition) {
      return true; // No filter
    }
    
    // Check for OR operator first (lower precedence)
    // Split by OR, then each part can have AND conditions
    if (condition.includes(' OR ')) {
      const orParts = condition.split(' OR ').map(p => p.trim());
      // Any OR part can be true
      return orParts.some(orPart => this.evaluateWhereCondition(itemValue, itemPath, orPart));
    }
    
    // Check for AND operator (higher precedence)
    if (condition.includes(' AND ')) {
      const andParts = condition.split(' AND ').map(p => p.trim());
      // All AND parts must be true
      return andParts.every(andPart => this.evaluateSingleCondition(itemValue, itemPath, andPart));
    }
    
    // Single condition, no AND/OR
    return this.evaluateSingleCondition(itemValue, itemPath, condition);
  }
  
  /**
   * Resolve relative path from a base path
   * @param {Array} basePath - JSONPath array (e.g., ['$', 'users', 0, 'address'])
   * @param {string} relativePath - Relative path (e.g., '../email' or '../../name')
   * @returns {string} - Resolved absolute JSONPath
   */
  resolveRelativePath(basePath, relativePath) {
    if (!relativePath.startsWith('../') && !relativePath.startsWith('./')) {
      // Already absolute or simple field name
      return relativePath;
    }
    
    // Count how many levels to go up
    const upLevels = (relativePath.match(/\.\.\//g) || []).length;
    const fieldPath = relativePath.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
    
    // Navigate up the base path
    // Each "../" removes one path segment from the end
    // For ../../id from rate_data[0].source:
    //   Start: ['$', 'hotel_data', 0, 'room_data', 0, 'rate_data', 0, 'source']
    //   After ../: ['$', 'hotel_data', 0, 'room_data', 0, 'rate_data', 0]
    //   After ../: ['$', 'hotel_data', 0, 'room_data', 0, 'rate_data']
    //   Hmm, that gives rate_data.id, not room_data[0].id
    //
    // Actually, ../ should go to the parent OBJECT, so:
    //   ../ from rate_data[0].source → rate_data[0]
    //   ../ from rate_data[0] → room_data[0] (skip over rate_data field AND its index)
    // 
    // So we need to skip backwards more intelligently:
    // - If current is a field name, remove it and any index before it
    // - If current is an index, remove it and the field before it
    
    let newPath = [...basePath];
    
    for (let i = 0; i < upLevels; i++) {
      if (newPath.length <= 1) break; // Don't go past '$'
      
      const last = newPath[newPath.length - 1];
      
      if (typeof last === 'string' && last !== '$') {
        // Last element is a field name - remove it
        newPath.pop();
        // If the element before it is an index, we're done (we're now at parent[index])
        // If the element before it is NOT an index, remove it too (go up another level)
        if (newPath.length > 1 && typeof newPath[newPath.length - 1] !== 'number') {
          // No index, so remove the parent field too to go up to grandparent
          newPath.pop();
        }
      } else if (typeof last === 'number') {
        // Last element is an index - remove it and the field before it
        newPath.pop();
        if (newPath.length > 1 && typeof newPath[newPath.length - 1] === 'string') {
          newPath.pop();
        }
      }
    }
    
    // Build the resolved path string
    let resolved = QueryExecutor.pathArrayToString(newPath);
    
    // Append the field path
    if (fieldPath) {
      if (fieldPath.startsWith('[')) {
        resolved += fieldPath;
      } else {
        resolved += '.' + fieldPath;
      }
    }
    
    return resolved;
  }
  
  /**
   * Resolve wildcards in label query by matching indices from result path
   * @param {Array} resultPath - Actual result path with indices (e.g., ['$', 'parents', 0, 'child', 1, 'name'])
   * @param {string} labelQuery - Label query with wildcards (e.g., '$.parents[*].name')
   * @returns {string} - Label query with wildcards replaced by actual indices
   */
  resolveWildcardIndices(resultPath, labelQuery) {
    // If no wildcards in label query, return as-is
    if (!labelQuery.includes('[*]')) {
      return labelQuery;
    }
    
    // Build a list of (fieldName, index) pairs in order from the result path
    const pathIndices = [];
    for (let i = 0; i < resultPath.length; i++) {
      const part = resultPath[i];
      if (typeof part === 'number' && i > 0) {
        // This is an array index, map it to the previous field name
        const fieldName = resultPath[i - 1];
        if (typeof fieldName === 'string') {
          pathIndices.push({ field: fieldName, index: part });
        }
      }
    }
    
    // Now replace wildcards in the label query in order
    let resolved = labelQuery;
    let pathIndexPos = 0; // Track position in pathIndices
    
    // Process wildcards one at a time, left to right
    while (resolved.includes('[*]') && pathIndexPos < pathIndices.length) {
      // Find the next [*] wildcard
      const wildcardPos = resolved.indexOf('[*]');
      if (wildcardPos === -1) break;
      
      // Find the field name before [*]
      // Work backwards from wildcardPos to find the field name
      // Handle both dot notation (.field[*]) and bracket notation (['field'][*])
      let fieldStart = wildcardPos - 1;
      let inBracket = false;
      let inQuote = false;
      let quoteChar = null;
      
      while (fieldStart >= 0) {
        const char = resolved[fieldStart];
        
        // Track if we're inside quotes
        if ((char === '"' || char === "'") && (fieldStart === 0 || resolved[fieldStart - 1] !== '\\')) {
          if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else if (char === quoteChar) {
            inQuote = false;
            quoteChar = null;
          }
        }
        
        // If we hit an opening bracket and we're not in a quote, we're done
        if (char === '[' && !inQuote) {
          inBracket = true;
          fieldStart++;
          break;
        }
        
        // If we hit a dot and we're not in bracket/quote, we're done
        if (char === '.' && !inQuote && !inBracket) {
          fieldStart++;
          break;
        }
        
        fieldStart--;
      }
      
      if (fieldStart < 0) fieldStart = 0;
      
      let fieldName = resolved.substring(fieldStart, wildcardPos);
      
      // Clean up the field name - remove quotes and brackets
      fieldName = fieldName.replace(/^\[['"]?/, '').replace(/['"]?\]?$/, '').trim();
      
      // Find matching index from pathIndices
      let matchingIndex = null;
      for (let i = pathIndexPos; i < pathIndices.length; i++) {
        if (pathIndices[i].field === fieldName) {
          matchingIndex = pathIndices[i].index;
          pathIndexPos = i + 1; // Move to next index for next wildcard
          break;
        }
      }
      
      // Replace [*] with actual index
      if (matchingIndex !== null) {
        resolved = resolved.substring(0, wildcardPos) + 
                   `[${matchingIndex}]` + 
                   resolved.substring(wildcardPos + 3); // 3 = length of "[*]"
      } else {
        // No matching index found, leave as is and break to avoid infinite loop
        break;
      }
    }
    
    return resolved;
  }
  
  // Get blessed style object for borders
  getBoxStyle(borderColor) {
    return {
      border: {
        fg: '#7aa2f7'  // Consistent blue border color
      }
    };
  }

  init() {
    // Create screen using /dev/tty for input/output
    const tty = require('tty');
    const fs = require('fs');
    
    let input, output;
    try {
      const fd = fs.openSync('/dev/tty', 'r+');
      input = new tty.ReadStream(fd);
      output = new tty.WriteStream(fd);
    } catch (e) {
      console.error('Error: Cannot open /dev/tty for interactive mode');
      console.error('TUI mode requires a terminal. Try --cli mode instead:');
      console.error('  cat file.json | jojq --cli');
      process.exit(1);
    }
    
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'jojq - Interactive JSON Navigator',
      fullUnicode: true,
      input: input,
      output: output
    });

    // Top-left: Info/Help box (50% width, hidden by default)
    // Press F1 to toggle help visibility
    this.infoBox = blessed.box({
      top: 0,
      left: 0,
      width: '50%',
      height: 0, // Hidden by default
      content: this.getHelpText(false),
      tags: true,
      border: {
        type: 'line'
      },
      style: this.getBoxStyle('info'),
      label: ' Help (F1) ',
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        inverse: true
      },
      mouse: true,
      keys: true,
      vi: true,
      hidden: true // Start hidden
    });

    // Top-right: Results box (50% width, full right side)
    this.resultsBox = blessed.box({
      top: 0,
      left: '50%',
      width: '50%',
      height: '100%-3',
      content: this.wrapColor('Waiting for JSON input...', 'info'),
      tags: true,
      border: {
        type: 'line'
      },
      style: this.getBoxStyle('success'),
      label: ' Results ',
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        inverse: true
      },
      keys: true,
      vi: true,
      mouse: true,
      input: true,
      keyable: true,
      // Re-enable wrapping so we can see values
      wrap: true,
      // Allow unlimited scrollback for large result sets
      baseLimit: 1000000,
      scrollback: 1000000,
      // Increase child limit for large content
      childLimit: 1000000
    });

    // Left: Suggestions box (50% width, full height minus input)
    this.suggestionsBox = blessed.box({
      top: 0,
      left: 0,
      width: '50%',
      height: '100%-3', // Full height minus input box
      content: '',
      tags: true,
      border: {
        type: 'line'
      },
      style: this.getBoxStyle('warning'),
      label: ' Suggestions ',
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        inverse: true
      },
      mouse: true,
      keys: true,
      vi: true
    });

    // Bottom: Command input (full width, 3 lines)
    const inputStyle = this.getBoxStyle('highlight');
    inputStyle.bg = 'black';
    inputStyle.focus = {
      border: inputStyle.border,
      bg: 'black'
    };
    
    this.commandInput = blessed.textbox({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      inputOnFocus: true,
      keys: true,
      mouse: true,
      cursor: 'line',
      cursorBlink: true,
      border: {
        type: 'line'
      },
      style: inputStyle,
      label: ' Query (:help | Tab: Autocomplete | /: Search | ←/→: panels | ↑/↓: nav | Enter: copy | Esc: back) '
    });

    // Add all elements to screen
    this.screen.append(this.infoBox);
    this.screen.append(this.resultsBox);
    this.screen.append(this.suggestionsBox);
    this.screen.append(this.commandInput);

    // Focus command input by default
    this.commandInput.focus();

    // Setup event handlers
    this.setupEventHandlers();

    // Render
    this.screen.render();
  }

  getCenteredLogo() {
    const fs = require('fs');
    const pathModule = require('path');
    
    // Get the width of the info box (50% of screen, minus borders)
    const boxWidth = Math.floor(process.stdout.columns * 0.5) - 4;
    
    // Read and center the logo
    let logo = '';
    try {
      const logoPath = pathModule.join(__dirname, 'logo');
      const logoContent = fs.readFileSync(logoPath, 'utf8');
      const logoLines = logoContent.trim().split('\n');
      
      // Find minimum leading spaces to normalize alignment
      const leadingSpaces = logoLines.map(line => line.match(/^(\s*)/)[0].length);
      const minLeading = Math.min(...leadingSpaces);
      
      // Normalize by removing minimum leading spaces from all lines
      const normalizedLines = logoLines.map((line, i) => {
        const extraSpaces = leadingSpaces[i] - minLeading;
        return ' '.repeat(extraSpaces) + line.trimStart();
      });
      
      // Find the longest normalized line to center the logo as a block
      const maxLength = Math.max(...normalizedLines.map(line => line.length));
      const padding = Math.max(50)//Math.max(0, Math.floor((boxWidth - maxLength) / 2));
      
      // Add the same padding to all lines to preserve relative alignment
      logo = logoContent + " jojq - JSON Navigator"//normalizedLines.map(line => ' '.repeat(padding) + line).join('\n');
    } catch (e) {
      // Fallback if logo file can't be read
      const fallbackLines = ['┏┓┏━┓ ┏┓┏━┓', '  ┃┃ ┃  ┃┃┓┃', '┗━┛┗━┛┗━┛┗┻┛'];
      const leadingSpaces = fallbackLines.map(line => line.match(/^(\s*)/)[0].length);
      const minLeading = Math.min(...leadingSpaces);
      const normalizedLines = fallbackLines.map((line, i) => {
        const extraSpaces = leadingSpaces[i] - minLeading;
        return ' '.repeat(extraSpaces) + line.trimStart();
      });
      const maxLength = Math.max(...normalizedLines.map(line => line.length));
      const padding = Math.max(0, Math.floor((boxWidth - maxLength) / 2));
      logo = normalizedLines.map(line => ' '.repeat(padding) + line).join('\n');
    }
    
    return logo;
  }
  
  getHelpText(compact = false) {
    const w = this.wrapColor.bind(this);
    const boxWidth = Math.floor(process.stdout.columns * 0.5) - 4;
    
    const logo = this.getCenteredLogo();
    
    // Center the title too
    const title = '';
    const titlePadding = Math.max(0, Math.floor((boxWidth - title.length) / 2));
    
    // Compact mode: just logo and title
    if (compact) {
      return `${logo}

${' '.repeat(titlePadding)}{bold}${title}{/bold}

${w('Press', 'dim')} ${w('F1', 'highlight')} ${w('to toggle full help', 'dim')}`;
    }
    
    // Full help text
    return `${logo}

${w('Commands:', 'info')}
${w(':help', 'highlight')}     Show help
${w(':show', 'highlight')}     Show full JSON
${w(':paths', 'highlight')}    List all paths
${w(':save', 'highlight')}     Save last result
${w(':dump', 'highlight')}     Save full JSON
${w(':saveline', 'highlight')} Save with line#
${w(':copy', 'highlight')}          Copy result to clipboard
${w(':copy-query', 'highlight')}   Copy the last query
${w(':copy-results', 'highlight')} Copy displayed results (labels → values)
${w(':raw', 'highlight')}      Raw mode (select text)
${w(':keys', 'highlight')}     Show/manage keybindings
${w(':exit', 'highlight')}     Exit (or Ctrl+C)

${w('Auto-Decode/Parse:', 'info')}
When encoded content is detected,
you'll be prompted: ${w('Parse it? (y/n)', 'highlight')}
Or use ${w(':decode', 'highlight')} / ${w(':parse', 'highlight')} manually

${w('Search:', 'info')}
${w('/term', 'highlight')}     Search entire JSON (show matches list)
${w('//term', 'highlight')}    Same as / unless viewing selected item,
               then highlights matches in that item
${w('n', 'highlight')}         Next page
${w('p', 'highlight')}         Previous page

${w('Panel Navigation:', 'info')}
${w('→ or Ctrl+D', 'highlight')} Switch to results panel
${w('← or Ctrl+I', 'highlight')} Switch to input panel
${w('↑/↓', 'highlight')}         Navigate results
${w('Enter', 'highlight')}       Copy selected result
${w('Esc', 'highlight')}         Back to input

${w('Input Panel:', 'info')}
${w('Tab', 'highlight')}       Autocomplete
${w('Ctrl+*', 'highlight')}    Insert [*] wildcard
${w('w:prefix', 'highlight')}  Wildcard mode (e.g., w:items)
${w('*suffix', 'highlight')}   Wildcard mode (e.g., items*)
${w('↑/↓', 'highlight')}       Navigate suggestions
               (or history when empty)
${w('F1', 'highlight')}        Toggle help
${w('Ctrl+U, Ctrl+C', 'highlight')}    Clear line
${w('Ctrl+W', 'highlight')}    Delete word
${w('Ctrl+A/E', 'highlight')}  Start/End

${w('Copy/Paste:', 'info')}
${w(':copy', 'highlight')}          Copy result JSON to clipboard
${w(':copy-query', 'highlight')}   Copy the last query
${w(':copy-results', 'highlight')} Copy displayed results (labels → values)
${w(':raw', 'highlight')}          Enter raw mode to select & copy text

${w('Wildcards with Labels & Filters:', 'info')}
${w('[*]', 'highlight')}       Match all items
  Ex: $.data[*].id
${w('| @label=', 'highlight')} Add contextual labels
  Ex: $.data[*].people | @label=../name
${w('| @where=', 'highlight')}  Filter results
  Ex: $.users[*] | @where=status=active
  Operators: ${w('=, !=, >, <, >=, <=, contains', 'dim')}
  Relative: ${w('@where=../field=value', 'dim')} (parent field)
  Logic: ${w('AND, OR', 'dim')} (e.g., status=active AND age>25)
  Combine: ${w('| @label=... | @where=...', 'dim')}`;
  }

  setupEventHandlers() {
    // Handle terminal resize
    this.screen.on('resize', () => {
      this.handleResize();
    });
    
    // Custom mouse wheel handlers for much slower scrolling
    // Track last scroll time for throttling
    this.lastScrollTime = 0;
    this.scrollThrottle = 100; // milliseconds between scroll events
    
    const slowScroll = (box, direction) => {
      const now = Date.now();
      
      // Throttle scroll events - only allow one every 100ms
      if (now - this.lastScrollTime < this.scrollThrottle) {
        return;
      }
      this.lastScrollTime = now;
      
      const currentScroll = box.getScroll();
      const scrollAmount = 1; // Scroll by 1 line at a time
      
      if (direction === 'up') {
        box.setScroll(Math.max(0, currentScroll - scrollAmount));
      } else {
        box.setScroll(currentScroll + scrollAmount);
      }
      this.screen.render();
    };
    
    // Add wheel handlers to all scrollable boxes
    this.infoBox.on('wheeldown', () => slowScroll(this.infoBox, 'down'));
    this.infoBox.on('wheelup', () => slowScroll(this.infoBox, 'up'));
    
    this.resultsBox.on('wheeldown', () => slowScroll(this.resultsBox, 'down'));
    this.resultsBox.on('wheelup', () => slowScroll(this.resultsBox, 'up'));
    
    this.suggestionsBox.on('wheeldown', () => slowScroll(this.suggestionsBox, 'down'));
    this.suggestionsBox.on('wheelup', () => slowScroll(this.suggestionsBox, 'up'));
    
    // Quit on Control-C
    this.screen.key(['C-c'], () => {
      return process.exit(0);
    });
    
    // Escape - return to input panel or exit
    this.screen.key(['escape'], () => {
      if (this.focusedPanel !== 'input') {
        this.switchFocus('input');
      } else {
        // If in proxy mode, destroy screen and let proxy handle exit
        // Otherwise, exit immediately
        if (this.proxyMode) {
          this.screen.destroy();
        } else {
          return process.exit(0);
        }
      }
    });
    
    // Ctrl+D - switch to results panel (Ctrl+R doesn't work in some terminals)
    this.screen.key(['C-d'], () => {
      if (this.focusedPanel === 'input' && this.hasResults()) {
        this.switchFocus('results');
      }
    });
    
    // Ctrl+I - switch back to input panel
    this.screen.key(['C-i'], () => {
      if (this.focusedPanel === 'results') {
        this.switchFocus('input');
      }
    });
    
    // Right arrow - switch to results panel (when results exist)
    this.screen.key(['right'], () => {
      if (this.focusedPanel === 'input' && this.hasResults()) {
        this.switchFocus('results');
      }
    });
    
    // Left arrow - switch back to input panel
    this.screen.key(['left'], () => {
      if (this.focusedPanel === 'results') {
        this.switchFocus('input');
      }
    });

    // Note: up/down/enter handlers are dynamically added in switchFocus() to avoid duplicates

    // Input handling
    this.commandInput.on('submit', (value) => {
      const trimmedValue = value ? value.trim() : '';
      
      // If there are suggestions and one is selected, use the selected suggestion
      if (this.suggestions.length > 0 && this.selectedIndex >= 0 && this.selectedIndex < this.suggestions.length) {
        const selected = this.suggestions[this.selectedIndex];
        // Execute the selected suggestion (could be a command, path, or search)
        this.executeQuery(selected.path);
      } else if (trimmedValue) {
        // No suggestion selected, execute what user typed
        this.executeQuery(trimmedValue);
      }
      
      this.commandInput.clearValue();
      this.updateSuggestions(''); // Reset to show initial suggestions
      this.commandInput.focus();
      this.screen.render();
    });

    // Mac-style keyboard shortcuts for text editing
    this.commandInput.key(['C-a'], () => {
      // Ctrl+A or Cmd+A - Select all (move to start for now)
      this.commandInput.value = this.commandInput.getValue();
      this.commandInput.screen.render();
    });

    this.commandInput.key(['C-e'], () => {
      // Ctrl+E - Move to end of line
      const val = this.commandInput.getValue();
      this.commandInput.value = val;
      this.commandInput.screen.render();
    });

    this.commandInput.key(['C-u'], () => {
      // Ctrl+U - Delete from cursor to beginning of line
      this.commandInput.clearValue();
      this.updateSuggestions('');
      this.commandInput.screen.render();
    });

    this.commandInput.key(['C-c'], () => {
      // Ctrl+U - Delete from cursor to beginning of line
      this.commandInput.clearValue();
      this.updateSuggestions('');
      this.commandInput.screen.render();
    });

    this.commandInput.key(['C-k'], () => {
      // Ctrl+K - Delete from cursor to end of line
      this.commandInput.clearValue();
      this.updateSuggestions('');
      this.commandInput.screen.render();
    });

    this.commandInput.key(['C-w'], () => {
      // Ctrl+W - Delete word backward
      const val = this.commandInput.getValue();
      if (!val) return;
      
      // Delete backward through the string more intelligently
      // Keep deleting until we've removed at least one alphanumeric character
      let newVal = val;
      let deletedAlphanumeric = false;
      
      while (newVal.length > 0 && !deletedAlphanumeric) {
        const lastChar = newVal[newVal.length - 1];
        newVal = newVal.slice(0, -1);
        
        // If we just deleted an alphanumeric character, we might be done
        if (/[a-zA-Z0-9_]/.test(lastChar)) {
          deletedAlphanumeric = true;
          // Continue deleting alphanumeric characters until we hit a non-alphanumeric
          while (newVal.length > 0 && /[a-zA-Z0-9_]/.test(newVal[newVal.length - 1])) {
            newVal = newVal.slice(0, -1);
          }
        }
      }
      
      this.commandInput.setValue(newVal);
      this.updateSuggestions(newVal);
      this.commandInput.screen.render();
    });

    // Alt/Option + Left Arrow - Jump to previous word
    this.commandInput.key(['M-left', 'C-left'], () => {
      const val = this.commandInput.getValue();
      // For now, move to start (blessed has limited cursor control)
      this.commandInput.screen.render();
    });

    // Alt/Option + Right Arrow - Jump to next word
    this.commandInput.key(['M-right', 'C-right'], () => {
      const val = this.commandInput.getValue();
      // For now, move to end (blessed has limited cursor control)
      this.commandInput.screen.render();
    });

    // Alt/Option + Backspace - Delete previous word (Ctrl+W also does this, see above)
    this.commandInput.key(['M-backspace'], () => {
      const val = this.commandInput.getValue();
      if (!val) return;
      
      // Delete backward through the string more intelligently
      // Keep deleting until we've removed at least one alphanumeric character
      let newVal = val;
      let deletedAlphanumeric = false;
      
      while (newVal.length > 0 && !deletedAlphanumeric) {
        const lastChar = newVal[newVal.length - 1];
        newVal = newVal.slice(0, -1);
        
        // If we just deleted an alphanumeric character, we might be done
        if (/[a-zA-Z0-9_]/.test(lastChar)) {
          deletedAlphanumeric = true;
          // Continue deleting alphanumeric characters until we hit a non-alphanumeric
          while (newVal.length > 0 && /[a-zA-Z0-9_]/.test(newVal[newVal.length - 1])) {
            newVal = newVal.slice(0, -1);
          }
        }
      }
      
      this.commandInput.setValue(newVal);
      this.updateSuggestions(newVal);
      this.commandInput.screen.render();
    });

    // Handle tab for autocomplete at input level (before screen processes it)
    this.commandInput.key(['tab'], () => {
      this.handleTab();
      return false; // Prevent default tab behavior
    });
    
    // Handle Ctrl+* or Alt+* for wildcard shortcut
    this.commandInput.key(['C-*', 'M-*'], () => {
      const currentValue = this.commandInput.getValue();
      // If cursor is at end of a field name, add [*]
      // Otherwise, insert [*] at cursor position
      if (currentValue.endsWith(']') || currentValue.endsWith('.')) {
        this.commandInput.setValue(currentValue + '[*]');
      } else {
        // Find the last field and add [*] after it
        const match = currentValue.match(/([a-zA-Z_$][\w$]*)$/);
        if (match) {
          const before = currentValue.substring(0, match.index);
          const field = match[0];
          this.commandInput.setValue(before + field + '[*]');
        } else {
          this.commandInput.setValue(currentValue + '[*]');
        }
      }
      this.updateSuggestions(this.commandInput.getValue());
      this.screen.render();
      return false;
    });
    
    // Handle up/down for suggestion navigation at input level
    this.commandInput.key(['up'], () => {
      if (this.focusedPanel === 'input') {
        this.handleArrowKey('up');
        return false; // Prevent default only in input mode
      }
      // Don't prevent default if in results mode
    });
    
    this.commandInput.key(['down'], () => {
      if (this.focusedPanel === 'input') {
        this.handleArrowKey('down');
        return false; // Prevent default only in input mode
      }
      // Don't prevent default if in results mode
    });
    
    // Handle left/right arrow for mode switching and cursor movement
    this.commandInput.key(['left'], () => {
      if (this.focusedPanel === 'results') {
        // Switch back to input from results
        this.switchFocus('input');
        return false;
      }
      // Otherwise, let left arrow move cursor normally (return undefined, don't prevent)
    });
    
    this.commandInput.key(['right'], () => {
      if (this.focusedPanel === 'results') {
        // Already in results, do nothing (let screen handler deal with it)
        return false;
      }
      
      if (this.focusedPanel === 'input' && this.hasResults()) {
        // Check if cursor is at the end of the input
        const val = this.commandInput.getValue();
        const cursorPos = this.commandInput.value.length;
        
        // Only switch to results if cursor is at the end
        if (cursorPos >= val.length) {
          this.switchFocus('results');
          return false; // Prevent default behavior
        }
      }
      // Otherwise, let the right arrow move the cursor normally
    });
    
    // Real-time input for suggestions
    this.commandInput.on('keypress', (ch, key) => {
      // If waiting for y/n prompt, intercept and handle
      if (this.waitingForPrompt && (ch === 'y' || ch === 'n' || ch === 'Y' || ch === 'N')) {
        // The textbox has already added the character, so remove it
        const currentValue = this.commandInput.getValue();
        if (currentValue === ch) {
          // It's only the prompt character, clear it
          this.commandInput.clearValue();
        } else if (currentValue.endsWith(ch)) {
          // Remove the last character (the one just typed)
          this.commandInput.setValue(currentValue.slice(0, -1));
        }
        this.handlePromptResponse(ch);
        return false; // Prevent further processing
      }
      
      // Skip arrow keys, they're handled above
      if (key.name === 'up' || key.name === 'down' || key.name === 'left' || key.name === 'right') {
        return;
      } else if (key.name === 'tab') {
        // Tab is already handled above
        return false;
      } else {
        // Update suggestions as user types with debouncing
        // Clear existing timer
        if (this.suggestionDebounceTimer) {
          clearTimeout(this.suggestionDebounceTimer);
        }
        
        // Use setImmediate to ensure the input value has been updated
        // The keypress event fires BEFORE the character is added to the input
        setImmediate(() => {
          const currentValue = this.commandInput.getValue();
          
          // For commands (:) and search (/), update immediately without debounce
          // This prevents delays when typing :q, :cr, etc. quickly
          if (currentValue.startsWith(':') || currentValue.startsWith('/')) {
            this.updateSuggestions(currentValue);
          } else {
            // For regular queries, use debounce for performance
            const sizeInfo = appState.jsonData ? PathExtractor.estimateSize(appState.jsonData) : { isLarge: false };
            const debounceMs = sizeInfo.isLarge ? 200 : 150;
            
            this.suggestionDebounceTimer = setTimeout(() => {
              this.updateSuggestions(this.commandInput.getValue());
            }, debounceMs);
          }
        });
      }
    });

    // F1 to toggle help visibility
    this.helpVisible = false; // Track help visibility
    this.screen.key(['f1'], () => {
      this.helpVisible = !this.helpVisible;
      
      if (this.helpVisible) {
        // Show help box
        const terminalHeight = process.stdout.rows || 24;
        const isCompact = terminalHeight < 30;
        
        this.infoBox.height = isCompact ? '20%' : '40%';
        this.infoBox.show();
        this.infoBox.setContent(this.getHelpText(false));
        this.infoBox.setLabel(' Info & Commands ');
        
        // Adjust suggestions box
        this.suggestionsBox.top = isCompact ? '20%' : '40%';
        this.suggestionsBox.height = isCompact ? '80%-3' : '60%-3';
      } else {
        // Hide help box
        this.infoBox.height = 0;
        this.infoBox.hide();
        
        // Expand suggestions box to full height
        this.suggestionsBox.top = 0;
        this.suggestionsBox.height = '100%-3';
      }
      
      this.screen.render();
    });

    // Mouse support for results scrolling
    this.resultsBox.on('wheeldown', () => {
      this.resultsBox.scroll(3);
      this.screen.render();
    });

    this.resultsBox.on('wheelup', () => {
      this.resultsBox.scroll(-3);
      this.screen.render();
    });
    
    // If JSON was preloaded (e.g., from proxy mode), load it immediately
    if (this.preloadedJSON) {
      // Load JSON and show suggestions immediately
      this.loadJSON(this.preloadedJSON);
    } else {
      // Show placeholder - will be updated when JSON loads
      const w = this.wrapColor.bind(this);
      this.suggestionsBox.setContent(w('Waiting for JSON input...', 'dim'));
      this.screen.render();
    }
  }

  handleArrowKey(direction) {
    // Navigate through combined history + suggestions list
    if (direction === 'up' && this.selectedIndex > 0) {
      this.selectedIndex--;
      this.updateSuggestions(this.commandInput.getValue(), true); // Keep selection
    } else if (direction === 'down' && this.selectedIndex < this.suggestions.length - 1) {
      this.selectedIndex++;
      this.updateSuggestions(this.commandInput.getValue(), true); // Keep selection
    }
  }

  handleTab() {
    if (this.suggestions.length > 0 && this.selectedIndex < this.suggestions.length) {
      const selected = this.suggestions[this.selectedIndex];
      this.commandInput.setValue(selected.path);
      this.updateSuggestions(selected.path);
      this.screen.render();
    }
  }
  
  hasResults() {
    // Check if there's any content to view in the results box
    return (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults && this.lastWildcardResults.length > 0) ||
           (this.lastDisplayedType === 'search' && appState.lastSearchResults.length > 0) ||
           (this.lastDisplayedType === 'result'); // For results, help, paths, etc - just check if display type is set
  }
  
  switchFocus(panel) {
    this.focusedPanel = panel;
    
    // Update visual feedback
    if (panel === 'input') {
      this.commandInput.style.border.fg = 'magenta';
      this.resultsBox.style.border.fg = 'green';
      
      // Detach all key handlers from screen when in input mode
      this.screen.unkey(['up', 'down', 'left', 'right', 'enter', 'n', 'p']);
      
      this.commandInput.focus();
    } else if (panel === 'results') {
      this.commandInput.style.border.fg = 'gray';
      this.resultsBox.style.border.fg = 'yellow';
      this.resultsSelectedIndex = 0;
      
      // Remove focus from input entirely
      this.commandInput.emit('blur');
      
      // Track last navigation time for throttling
      this.lastNavigationTime = 0;
      
      // Attach screen-level key handlers for results navigation with throttling
      this.screen.key(['up'], () => {
        if (this.focusedPanel === 'results') {
          const now = Date.now();
          if (now - this.lastNavigationTime > 50) { // Throttle to 50ms
            this.lastNavigationTime = now;
            this.navigateResults('up');
          }
        }
      });
      
      this.screen.key(['down'], () => {
        if (this.focusedPanel === 'results') {
          const now = Date.now();
          if (now - this.lastNavigationTime > 50) { // Throttle to 50ms
            this.lastNavigationTime = now;
            this.navigateResults('down');
          }
        }
      });
      
      this.screen.key(['left', 'escape'], () => {
        if (this.focusedPanel === 'results') {
          this.switchFocus('input');
        }
      });
      
      // Add n/p handlers for navigating search matches
      this.screen.key(['n'], () => {
        if (this.focusedPanel === 'results' && this.searchMatches.length > 0) {
          this.navigateToNextMatch();
        }
      });
      
      this.screen.key(['p'], () => {
        if (this.focusedPanel === 'results' && this.searchMatches.length > 0) {
          this.navigateToPrevMatch();
        }
      });
      
      this.screen.key(['enter'], () => {
        if (this.focusedPanel === 'results') {
          this.copySelectedResult();
        }
      });
      
      // Refresh display based on result type
      if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults) {
        this.highlightWildcardResult();
      } else if (this.lastDisplayedType === 'search' && appState.lastSearchResults.length > 0) {
        this.displayManager.displaySearchResults(); // Refresh to show selection
      }
      this.resultsBox.focus(); // Focus the results box for scrolling
    }
    
    this.screen.render();
  }
  
  navigateResults(direction) {
    if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults) {
      // Navigate wildcard results
      const maxIndex = this.lastWildcardResults.length - 1;
      
      if (direction === 'up' && this.resultsSelectedIndex > 0) {
        this.resultsSelectedIndex--;
        this.highlightWildcardResult();
      } else if (direction === 'down' && this.resultsSelectedIndex < maxIndex) {
        this.resultsSelectedIndex++;
        this.highlightWildcardResult();
      }
    } else if (this.lastDisplayedType === 'search') {
      // Navigate search results
      const pagedResults = appState.getPagedSearchResults();
      
      if (direction === 'up' && this.resultsSelectedIndex > 0) {
        this.resultsSelectedIndex--;
        this.displaySearchResults();
      } else if (direction === 'down' && this.resultsSelectedIndex < pagedResults.length - 1) {
        this.resultsSelectedIndex++;
        this.displaySearchResults();
      }
    }
  }
  
  highlightWildcardResult() {
    if (!this.lastWildcardResults || this.lastWildcardResults.length === 0) return;
    
    const w = this.wrapColor.bind(this);
    
    // Rebuild the display with highlighting
    const allLines = [];
    
    // Add header
    const labelQuery = this.lastQuery && this.lastQuery.includes('| @label=');
    const headerText = labelQuery 
      ? `✓ Found ${this.lastWildcardResults.length} matches (with labels)`
      : `✓ Found ${this.lastWildcardResults.length} matches`;
    
    let fullContent = w(headerText, 'success') + '\n' + w('(Scroll to view all)', 'dim') + '\n';
    
    // Rebuild all lines with highlighting for selected item
    for (let idx = 0; idx < this.lastWildcardResults.length; idx++) {
      const item = this.lastWildcardResults[idx];
      
      // Get display path (label or short path)
      let displayPath;
      if (this.lastDisplayedLabels && this.lastDisplayedLabels[idx]) {
        displayPath = this.lastDisplayedLabels[idx].label;
      } else {
        // Fallback to short path
        displayPath = QueryExecutor.formatWildcardPath(
          QueryExecutor.pathArrayToString(item.path),
          ''
        );
      }
      
      let valuePreview = '';
      if (typeof item.value === 'string') {
        valuePreview = `"${item.value.substring(0, 40)}"`;
      } else if (typeof item.value === 'number' || typeof item.value === 'boolean') {
        valuePreview = String(item.value);
      } else if (item.value === null) {
        valuePreview = 'null';
      } else {
        valuePreview = JSON.stringify(item.value).substring(0, 40);
      }
      
      const lineNumber = w(`[${idx + 1}]`, 'dim');
      
      // Highlight selected line with a unique marker for scroll tracking
      if (idx === this.resultsSelectedIndex) {
        allLines.push(`{#SELECTED#}${w('►', 'highlight')} ${lineNumber} ${w(displayPath, 'highlight')} → ${w(valuePreview, 'highlight')}`);
      } else {
        allLines.push(`  ${lineNumber} ${w(displayPath, 'path')} → ${valuePreview}`);
      }
    }
    
    fullContent += allLines.join('\n');
    
    // Add scrolling tip
    if (this.lastWildcardResults.length > 10) {
      fullContent += '\n\n' + w(`Showing all ${this.lastWildcardResults.length} results - use ↑/↓ to navigate, Enter to copy`, 'dim');
    }
    
    // Set content
    this.resultsBox.setContent(fullContent);
    
    // Scroll to keep selected item visible
    // Search for our unique marker {#SELECTED#} in the rendered content
    const contentLines = this.resultsBox.getContent().split('\n');
    let markerLineIndex = -1;
    
    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].includes('{#SELECTED#}')) {
        markerLineIndex = i;
        break;
      }
    }
    
    if (markerLineIndex >= 0) {
      // Found the selected line, scroll to keep it visible
      const viewportHeight = this.resultsBox.height - 2;
      const currentScroll = this.resultsBox.getScroll();
      const topVisible = currentScroll;
      const bottomVisible = currentScroll + viewportHeight - 1;
      
      // Always scroll to center the selected line
      const targetScroll = Math.max(0, markerLineIndex - Math.floor(viewportHeight / 2));
      this.resultsBox.setScroll(targetScroll);
    }
    
    this.screen.render();
  }
  
  copySelectedResult() {
    if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults) {
      const selectedItem = this.lastWildcardResults[this.resultsSelectedIndex];
      
      // Get the parent path (remove the last field from the path)
      const pathArray = selectedItem.path;
      if (pathArray && pathArray.length > 1) {
        // Remove the last element to get the parent path
        const parentPathArray = pathArray.slice(0, -1);
        const parentPathString = QueryExecutor.pathArrayToString(parentPathArray);
        
        // Execute the parent path query to get the parent object
        const result = this.queryExecutor.execute(parentPathString);
        
        if (result.success) {
          // Store and display the parent object
          appState.setLastResult(result.data, parentPathString);
          this.displayManager.displayResult(result.data, parentPathString);
          
          // Switch back to input
          this.switchFocus('input');
        } else {
          const w = this.wrapColor.bind(this);
          this.resultsBox.setLine(this.resultsBox.height - 2, w(`✗ Failed to navigate to parent: ${result.error}`, 'error'));
          this.screen.render();
        }
      }
    } else if (this.lastDisplayedType === 'result') {
      // Copy the full result
      this.copyToClipboard().catch(err => {
        const w = this.wrapColor.bind(this);
        this.resultsBox.setContent(w(`❌ Error: ${err.message}`, 'error'));
        this.screen.render();
      });
    }
  }

  updateSuggestions(input, keepSelection = false) {
    // Normalize input for comparison (treat null/undefined as empty string)
    const normalizedInput = input || '';
    const normalizedLast = this.lastSuggestionInput || '';
    
    // Skip if input hasn't changed (performance optimization)
    // But allow initial call even if both are empty (first time showing suggestions)
    if (normalizedInput === normalizedLast && !keepSelection && this.lastSuggestionInput !== null) {
      return;
    }
    this.lastSuggestionInput = normalizedInput;
    
    // Check cache first (for large files, but not for commands)
    // Commands should always be regenerated since they filter based on input
    const cacheKey = input;
    if (!input.startsWith(':') && this.suggestionCache.has(cacheKey) && !keepSelection) {
      const cached = this.suggestionCache.get(cacheKey);
      this.suggestions = cached.suggestions;
      this.selectedIndex = Math.min(this.selectedIndex, this.suggestions.length - 1);
      this.renderSuggestions(cached.content);
      return;
    }
    
    const w = this.wrapColor.bind(this);
    const success = TUI_COLORS.success;
    const dim = TUI_COLORS.dim;
    const info = TUI_COLORS.info;
    
    // Handle keybinding command suggestions
    const isBindCommand = input.startsWith(':bind');
    const isUnbindCommand = input.startsWith(':unbind');
    const isResetCommand = input.startsWith(':reset-keys');
    
    if (isBindCommand || isUnbindCommand || isResetCommand) {
      let commandPart = '';
      if (isBindCommand) {
        commandPart = input.substring(5).trim(); // ':bind'
        if (commandPart.startsWith(' ')) commandPart = commandPart.substring(1);
      } else if (isUnbindCommand) {
        commandPart = input.substring(7).trim(); // ':unbind'
        if (commandPart.startsWith(' ')) commandPart = commandPart.substring(1);
      } else if (isResetCommand) {
        commandPart = input.substring(11).trim(); // ':reset-keys'
        if (commandPart.startsWith(' ')) commandPart = commandPart.substring(1);
      }
      
      const parts = commandPart.split(' ');
      const suggestions = [];
      
      if (parts.length === 1) {
        // Suggesting command names
        const partial = parts[0].toLowerCase();
        const allCommands = Object.keys(keybindingsManager.getAllKeybindings());
        
        const matchingCommands = allCommands.filter(cmd => 
          cmd.toLowerCase().includes(partial)
        ).sort();
        
        matchingCommands.forEach(cmd => {
          const keys = keybindingsManager.getKeybindings(cmd);
          const preview = keys.length > 0 ? `(${keys.join(', ')})` : '(no bindings)';
          suggestions.push({
            type: 'command',
            path: isBindCommand ? `:bind ${cmd} ` : 
                  isUnbindCommand ? `:unbind ${cmd} ` : 
                  `:reset-keys ${cmd}`,
            preview: preview
          });
        });
      } else if (parts.length === 2 && !isResetCommand) {
        // For :bind and :unbind, suggest current keybindings for the command
        const commandName = parts[0];
        const partialKey = parts[1];
        const currentKeys = keybindingsManager.getKeybindings(commandName);
        
        if (isUnbindCommand) {
          // For unbind, suggest existing keys
          currentKeys.forEach(key => {
            if (key.toLowerCase().includes(partialKey.toLowerCase())) {
              suggestions.push({
                type: 'key',
                path: `:unbind ${commandName} ${key}`,
                preview: '(remove this binding)'
              });
            }
          });
        } else {
          // For bind, show current keys as reference and suggest common patterns
          const commonKeys = [':c', ':cp', ':x', ':q', ':w', ':h', 'f2', 'f3', 'f4'];
          const filteredCommon = commonKeys.filter(k => 
            k.toLowerCase().includes(partialKey.toLowerCase()) &&
            !currentKeys.includes(k)
          );
          
          filteredCommon.forEach(key => {
            suggestions.push({
              type: 'key',
              path: `:bind ${commandName} ${key}`,
              preview: '(add this binding)'
            });
          });
          
          // Also show current bindings for reference
          if (currentKeys.length > 0 && partialKey === '') {
            suggestions.push({
              type: 'info',
              path: `# Current: ${currentKeys.join(', ')}`,
              preview: ''
            });
          }
        }
      }
      
      this.suggestions = suggestions.length > 0 ? suggestions : [{
        type: 'info',
        path: isBindCommand ? 'Type command name then keybinding' :
              isUnbindCommand ? 'Type command name then key to remove' :
              'Type command name to reset',
        preview: ''
      }];
      
      if (!keepSelection) {
        this.selectedIndex = 0;
      }
      
      let content = `{${dim}}${isBindCommand ? 'Bind' : isUnbindCommand ? 'Unbind' : 'Reset'} Command:{/${dim}}\n`;
      
      this.suggestions.forEach((item, index) => {
        const path = item.path;
        const preview = item.preview ? ` {${dim}}${item.preview}{/${dim}}` : '';
        const isSelected = index === this.selectedIndex;
        
        if (isSelected) {
          content += `{inverse}{${success}}▶ ${path}${preview}{/${success}}{/inverse}\n`;
        } else {
          if (item.type === 'info') {
            content += `  {${dim}}${path}{/${dim}}\n`;
          } else {
            content += `  ${path}${preview}\n`;
          }
        }
      });
      
      this.renderSuggestions(content);
      return;
    }
    
    // Check if input contains pipe syntax for label
    const pipeIndex = input.indexOf('|');
    let searchQuery = input;
    let isLabelPart = false;
    let isWherePart = false;
    let mainQuery = '';
    
    if (pipeIndex !== -1) {
      // User is typing pipe operators part
      mainQuery = input.substring(0, pipeIndex).trim();
      const pipePart = input.substring(pipeIndex + 1).trim();
      
      // Check for multiple pipes FIRST (before checking @where/@label)
      if (pipePart.includes('|')) {
        // Multiple pipes: | @label=... | @where=...
        const lastPipeIndex = pipePart.lastIndexOf('|');
        const lastPipePart = pipePart.substring(lastPipeIndex + 1).trim();
        
        if (lastPipePart === '' || lastPipePart === '@') {
          searchQuery = '@';
          isLabelPart = true;
        } else if (lastPipePart.startsWith('@where')) {
          const whereContent = lastPipePart.replace(/^@where\s*=?\s*/, '');
          
          // Check if we have a complete field=value pair using regex
          let hasCompleteCondition = false;
          const fieldPattern = /^(\.\.\/)*[\w$.'\[\]]+\s*(>=|<=|!=|=|>|<|contains)\s*(.+)$/;
          const match = whereContent.match(fieldPattern);
          
          if (match && match[3] && match[3].trim() !== '') {
            hasCompleteCondition = true;
          }
          
          if (!hasCompleteCondition) {
            searchQuery = whereContent;
            isWherePart = true;
            isLabelPart = true;
          } else {
            searchQuery = whereContent;
            isLabelPart = false;
          }
        } else if (lastPipePart.startsWith('@label')) {
          searchQuery = lastPipePart.replace(/^@label\s*=?\s*/, '');
          isLabelPart = true;
        }
      } else if (pipePart === '' || pipePart === '@') {
        // Show available pipe operators
        searchQuery = '@';
        isLabelPart = true;
      } else if (pipePart.startsWith('@where')) {
        // Typing where filter - extract the field part before operator
        const whereContent = pipePart.replace(/^@where\s*=?\s*/, '');
        
        // Check if we're still typing the field name (before any operator)
        // We need to find where the field ends and the operator begins
        let hasCompleteCondition = false;
        
        // For relative paths, the field itself can be complex: ../field, ../../field, etc.
        // We need to find the FIRST operator that appears AFTER a complete field path
        
        // Simple heuristic: if we have content after a non-initial operator character, we have a value
        // For example:
        // - "../board_type" -> no operator yet
        // - "../board_type=" -> operator found, but no value yet
        // - "../board_type=\"BREAKFAST\"" -> has value
        
        // Check if there's a field followed by operator followed by value
        const fieldPattern = /^(\.\.\/)*[\w$.'\[\]]+\s*(>=|<=|!=|=|>|<|contains)\s*(.+)$/;
        const match = whereContent.match(fieldPattern);
        
        if (match && match[3] && match[3].trim() !== '') {
          // Has field + operator + value
          hasCompleteCondition = true;
        }
        
        if (!hasCompleteCondition) {
          // Still typing field name or just typed operator - show suggestions
          searchQuery = whereContent;
          isWherePart = true;
          isLabelPart = true; // Reuse label suggestion logic
        } else {
          // After operator with value started - don't show suggestions
          searchQuery = whereContent;
          isLabelPart = false;
        }
      } else if (pipePart.startsWith('@label')) {
        // Typing label path
        searchQuery = pipePart.replace(/^@label\s*=?\s*/, '');
        isLabelPart = true;
      } else {
        // Backwards compatibility: assume label if no @ prefix
        searchQuery = pipePart;
        isLabelPart = true;
      }
    }
    
    // Build combined list: recent history + suggestions
    let combinedList = [];
    
    // If typing a command (starts with :), suggest available commands
    if (input.startsWith(':') && !isBindCommand && !isUnbindCommand && !isResetCommand) {
      const commandPart = input.substring(1).toLowerCase();
      const isJustColon = input === ':'; // Special case: just typed colon
      
      const availableCommands = [
        { cmd: ':help', aliases: [':h', '?'], desc: 'Show help' },
        { cmd: ':show', aliases: [], desc: 'Show full JSON' },
        { cmd: ':paths', aliases: [], desc: 'List all paths' },
        { cmd: ':save', aliases: [], desc: 'Save last result' },
        { cmd: ':dump', aliases: [':export'], desc: 'Save full JSON' },
        { cmd: ':saveline', aliases: [':sl'], desc: 'Save with line number' },
        { cmd: ':copy', aliases: [':c'], desc: 'Copy result to clipboard' },
        { cmd: ':copy-query', aliases: [':cq'], desc: 'Copy last query' },
        { cmd: ':copy-results', aliases: [':cr'], desc: 'Copy displayed results' },
        { cmd: ':raw', aliases: [], desc: 'Raw mode (select text)' },
        { cmd: ':keys', aliases: [':keybindings'], desc: 'Show/manage keybindings' },
        { cmd: ':bind', aliases: [], desc: 'Add keybinding' },
        { cmd: ':unbind', aliases: [], desc: 'Remove keybinding' },
        { cmd: ':reset-keys', aliases: [], desc: 'Reset keybindings to defaults' },
        { cmd: ':decode', aliases: [], desc: 'Decode URI-encoded content' },
        { cmd: ':parse', aliases: [], desc: 'Parse JSON string' },
        { cmd: ':exit', aliases: [':quit', ':q'], desc: 'Exit jojq' }
      ];
      
      const matches = [];
      
      availableCommands.forEach(({ cmd, aliases, desc }) => {
        // Check if command matches (exact prefix match required)
        if (cmd.startsWith(input)) {
          // Calculate score: exact match = 0, shorter difference = better
          const score = cmd === input ? 0 : cmd.length - input.length;
          matches.push({
            type: 'command',
            path: cmd,
            preview: desc,
            score: score
          });
        }
        
        // Check aliases (exact prefix match required)
        aliases.forEach(alias => {
          if (alias.startsWith(input)) {
            const score = alias === input ? 0 : alias.length - input.length;
            matches.push({
              type: 'command',
              path: alias,
              preview: `(alias for ${cmd}) ${desc}`,
              score: score
            });
          }
        });
      });
      
      // Sort by score (exact match first, then closest length), then alphabetically
      matches.sort((a, b) => {
        // Special case: if just typed ":", show full commands alphabetically (not aliases)
        if (isJustColon) {
          // Prioritize full commands over aliases
          const aIsAlias = a.preview && a.preview.includes('alias for');
          const bIsAlias = b.preview && b.preview.includes('alias for');
          if (aIsAlias !== bIsAlias) {
            return aIsAlias ? 1 : -1; // Full commands first
          }
          // Then alphabetically
          return a.path.localeCompare(b.path);
        }
        
        // Normal sorting: First, sort by score (lower is better - exact match = 0)
        if (a.score !== b.score) return a.score - b.score;
        // Then by length (shorter is better for partial matches)
        if (a.path.length !== b.path.length) return a.path.length - b.path.length;
        // Finally alphabetically
        return a.path.localeCompare(b.path);
      });
      
      // Only show matches that actually start with the input
      combinedList = matches;
      
      // For commands, we're done - skip the rest of the suggestion logic
      this.suggestions = combinedList;
      
      if (!keepSelection) {
        this.selectedIndex = 0; // Always select first command suggestion
      }
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.suggestions.length - 1));
      
      // Render command suggestions immediately (no caching for commands)
      let cmdContent = '';
      if (this.suggestions.length === 0) {
        // No matching commands
        cmdContent = w('No matching commands', 'dim');
      } else {
        this.suggestions.forEach((item, index) => {
          const preview = item.preview ? ` {${dim}}→ ${item.preview}{/${dim}}` : '';
          const isSelected = index === this.selectedIndex;
          
          if (isSelected) {
            cmdContent += `{inverse}{${success}}▶ ${item.path}${preview}{/${success}}{/inverse}\n`;
          } else {
            cmdContent += `  ${item.path}${preview}\n`;
          }
        });
      }
      
      // Render immediately (bypassing cache)
      this.suggestionsBox.setContent(cmdContent);
      this.screen.render();
      
      return; // Exit early - don't process path suggestions
    }
    
    // Add recent history items (reversed, most recent first) - only if no pipe syntax and not a command
    // (Don't show history when typing labels, filters, commands, or any pipe operators)
    if (pipeIndex === -1 && !input.startsWith(':')) {
      const recentHistory = this.commandHistory.slice(-5).reverse(); // Last 5 commands
      recentHistory.forEach(cmd => {
        combinedList.push({
          type: 'history',
          path: cmd,
          preview: null
        });
      });
    }
    
    // Check for wildcard shortcuts: w: prefix or * suffix
    const hasWildcardShortcut = searchQuery && (searchQuery.startsWith('w:') || searchQuery.endsWith('*'));
    const cleanSearchQuery = hasWildcardShortcut && searchQuery
      ? searchQuery.replace(/^w:/, '').replace(/\*$/, '')
      : searchQuery;
    
    // Add path suggestions
    let pathSuggestions = [];
    if (!cleanSearchQuery || cleanSearchQuery.trim() === '') {
      if (isLabelPart) {
        // Check if we're suggesting @ operators
        if (searchQuery === '@') {
          pathSuggestions = [
            { path: '@label=', preview: 'Add labels to wildcard results' },
            { path: '@where=', preview: 'Filter results by condition' }
          ];
        } else if (hasWildcardShortcut) {
          // User wants wildcard suggestions - show wildcard versions
          pathSuggestions = this.searchEngine.fuzzySearchPaths(cleanSearchQuery, true).slice(0, 10);
        } else {
          // Extract wildcards from main query to suggest matching label paths
          const wildcardPattern = /([a-zA-Z_$][\w$.'\[\]]*)\[\*\]/g;
          const wildcards = Array.from(mainQuery.matchAll(wildcardPattern));
          
          const labelSuggestions = [];
          
          // Suggest relative paths
          if (isWherePart) {
            // For @where, suggest common filter fields
            labelSuggestions.push({ path: '../status', preview: 'filter by parent status' });
            labelSuggestions.push({ path: '../type', preview: 'filter by parent type' });
            labelSuggestions.push({ path: '../source', preview: 'filter by parent source' });
            labelSuggestions.push({ path: '../id', preview: 'filter by parent id' });
            labelSuggestions.push({ path: '../../id', preview: 'filter by grandparent id' });
          } else {
            // For @label, suggest identifier fields
            labelSuggestions.push({ path: '../id', preview: 'parent id' });
            labelSuggestions.push({ path: '../name', preview: 'parent name' });
            labelSuggestions.push({ path: '../../id', preview: 'grandparent id' });
          }
        
        // If main query has wildcards, suggest matching absolute paths
        if (wildcards.length > 0) {
          // Build label path suggestions by removing the last wildcard level
          const lastWildcard = wildcards[wildcards.length - 1];
          const beforeLastWildcard = mainQuery.substring(0, lastWildcard.index);
          
          // Suggest paths at the parent wildcard level
          if (wildcards.length > 1) {
            const parentWildcard = wildcards[wildcards.length - 2];
            const parentPath = mainQuery.substring(0, parentWildcard.index + parentWildcard[0].length);
            
            labelSuggestions.unshift({ path: `${parentPath}.id`, preview: 'parent level id' });
            labelSuggestions.unshift({ path: `${parentPath}.name`, preview: 'parent level name' });
          }
          
          // Suggest same level fields
          labelSuggestions.unshift({ path: `${beforeLastWildcard}[*].id`, preview: 'same level id' });
          labelSuggestions.unshift({ path: `${beforeLastWildcard}[*].name`, preview: 'same level name' });
        }
        
        pathSuggestions = labelSuggestions;
        }
      } else {
        // Show more paths initially for better discoverability
        pathSuggestions = appState.allPaths.slice(0, 15).map(p => ({ path: p, score: 0 }));
      }
    } else {
      if (isLabelPart) {
        // For label part, include relative path suggestions if user is typing relative syntax
        const relativePaths = [];
        
        if (searchQuery.startsWith('..') || searchQuery.startsWith('.')) {
          // User is typing relative path - suggest common relative patterns
          // Different fields for @where vs @label
          const commonFields = isWherePart 
            ? ['status', 'type', 'source', 'id', 'name', 'board_type', 'rate_type', 'payment_type']
            : ['id', 'name', 'title', 'email', 'type', 'code', 'value'];
          
          if (cleanSearchQuery === '.' || cleanSearchQuery === '..' || cleanSearchQuery === '../') {
            // Just typed "../" - show all relative options
            const previewPrefix = isWherePart ? 'filter by parent' : 'parent';
            relativePaths.push({ path: '../status', preview: `${previewPrefix} status` });
            relativePaths.push({ path: '../type', preview: `${previewPrefix} type` });
            relativePaths.push({ path: '../source', preview: `${previewPrefix} source` });
            relativePaths.push({ path: '../id', preview: `${previewPrefix} id` });
            relativePaths.push({ path: '../name', preview: `${previewPrefix} name` });
            if (isWherePart) {
              relativePaths.push({ path: '../board_type', preview: 'filter by parent board_type' });
              relativePaths.push({ path: '../rate_type', preview: 'filter by parent rate_type' });
            }
            relativePaths.push({ path: '../../id', preview: `${isWherePart ? 'filter by' : ''} grandparent id` });
          } else {
            // User is typing specific relative path - match against common fields
            const levels = (searchQuery.match(/\.\.\//g) || []).length;
            const fieldPart = cleanSearchQuery.split('/').pop() || '';
            
            commonFields.forEach(field => {
              if (field.startsWith(fieldPart) || fieldPart === '') {
                const prefix = '../'.repeat(levels || 1);
                const fullPath = levels > 0 ? `${prefix}${field}` : `../${field}`;
                const levelDesc = levels === 0 ? 'parent' : 
                                 levels === 1 ? 'parent' :
                                 levels === 2 ? 'grandparent' : 
                                 `${levels} levels up`;
                relativePaths.push({ path: fullPath, preview: `${levelDesc} ${field}` });
              }
            });
          }
        }
        
        // Fuzzy search for absolute paths - prioritize wildcards when typing array paths
        const fuzzyResults = this.searchEngine.fuzzySearchPaths(searchQuery, true).slice(0, 10);
        
        // Filter to show paths that are related to the main query structure
        const filteredResults = fuzzyResults.filter(item => {
          const itemPath = item.path || item;
          // Show if it shares common structure with main query
          return mainQuery.split('[')[0].split('.').some(part => 
            itemPath.includes(part)
          );
        });
        
        // If wildcard shortcut was used, prioritize wildcard results
        if (hasWildcardShortcut) {
          // Move wildcard results to the top
          const wildcards = filteredResults.filter(r => (r.path || r).includes('[*]'));
          const nonWildcards = filteredResults.filter(r => !(r.path || r).includes('[*]'));
          pathSuggestions = [...wildcards, ...relativePaths, ...nonWildcards];
        } else {
          pathSuggestions = [...relativePaths, ...filteredResults];
        }
        
        // If no results, show all fuzzy results
        if (pathSuggestions.length === 0) {
          pathSuggestions = fuzzyResults;
        }
      } else {
        // Regular path search - prioritize wildcards when appropriate
        pathSuggestions = this.searchEngine.fuzzySearchPaths(searchQuery, true).slice(0, 10);
      }
    }
    
    pathSuggestions.forEach(item => {
      let displayPath = item.path || item;
      
      // If in label/where part, prepend the main query + all previous pipes
      if (isLabelPart && pipeIndex !== -1) {
        // Get everything up to the last pipe (including previous @label/@where parts)
        const everythingBeforeLastPipe = input.substring(0, input.lastIndexOf('|')).trim();
        
        // Check if the suggestion is an @ operator itself
        if (displayPath.startsWith('@')) {
          // Just show the operator with everything before
          displayPath = `${everythingBeforeLastPipe} | ${displayPath}`;
        } else if (isWherePart) {
          // Where condition path - add @where= prefix
          displayPath = `${everythingBeforeLastPipe} | @where=${displayPath}`;
        } else {
          // Regular label path - add @label= prefix
          displayPath = `${everythingBeforeLastPipe} | @label=${displayPath}`;
        }
      }
      
      const suggestionType = isWherePart ? 'where' : (isLabelPart ? 'label' : 'suggestion');
      const preview = isWherePart ? '(filter field)' : (isLabelPart ? (item.preview || '(label)') : (item.preview || null));
      
      combinedList.push({
        type: suggestionType,
        path: displayPath,
        preview: preview
      });
    });
    
    this.suggestions = combinedList;
    
    // Count history items for selection logic (only present when no pipe)
    const historyCount = (pipeIndex === -1) ? this.commandHistory.slice(-5).length : 0;
    
    // Reset selection if input changed (unless keepSelection is true for arrow navigation)
    if (!keepSelection) {
      // Default to first suggestion (after history)
      this.selectedIndex = historyCount;
    }
    
    // Constrain selectedIndex to valid range
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.suggestions.length - 1));

    let content = '';
    
    // Add header based on context
    if (isLabelPart) {
      content += `{${dim}}Label Paths:{/${dim}}\n`;
    } else if (historyCount > 0) {
      content += `{${dim}}Recent:{/${dim}}\n`;
    }
    
    this.suggestions.forEach((item, index) => {
      const path = item.path;
      const previewText = item.preview ? ` → ${item.preview}` : '';
      const preview = (dim && item.preview) ? ` {${dim}}→ ${item.preview}{/${dim}}` : previewText;
      const isSelected = index === this.selectedIndex;
      
      // Add separator between history and suggestions (only if not in label part)
      if (!isLabelPart && index === historyCount && historyCount > 0) {
        content += `{${dim}}Suggestions:{/${dim}}\n`;
      }
      
      if (isSelected) {
        if (success && success !== '') {
          content += `{inverse}{${success}}▶ ${path}${preview}{/${success}}{/inverse}\n`;
        } else {
          content += `{inverse}▶ ${path}${previewText}{/inverse}\n`;
        }
      } else {
        // Dim history items slightly
        if (item.type === 'history') {
          content += `  {${info}}${path}{/${info}}\n`;
        } else if (item.type === 'label') {
          content += `  {${dim}}${path}{/${dim}}\n`;
        } else {
          content += `  ${path}${preview}\n`;
        }
      }
    });

    this.renderSuggestions(content || w('No suggestions', 'dim'));
  }
  
  renderSuggestions(content) {
    const w = this.wrapColor.bind(this);
    this.suggestionsBox.setContent(content);
    
    // Cache the content (with size limit to prevent memory leak)
    const cacheKey = this.lastSuggestionInput;
    if (cacheKey && !cacheKey.startsWith(':')) { // Don't cache commands
      if (this.suggestionCache.size >= this.MAX_CACHE_SIZE) {
        // Remove oldest entry (first key in Map)
        const firstKey = this.suggestionCache.keys().next().value;
        this.suggestionCache.delete(firstKey);
      }
      this.suggestionCache.set(cacheKey, {
        suggestions: this.suggestions,
        content: content
      });
    }
    
    // Auto-scroll to keep selected item visible
    if (this.suggestions.length > 0) {
      const boxHeight = this.suggestionsBox.height - 2; // Subtract borders
      const currentScroll = this.suggestionsBox.getScroll();
      const selectedLine = this.selectedIndex;
      
      // If selected item is above visible area, scroll up
      if (selectedLine < currentScroll) {
        this.suggestionsBox.setScroll(selectedLine);
      }
      // If selected item is below visible area, scroll down
      else if (selectedLine >= currentScroll + boxHeight) {
        this.suggestionsBox.setScroll(selectedLine - boxHeight + 1);
      }
    }
    
    this.screen.render();
  }

  executeQuery(query) {
    if (!query || query.trim() === '') return;

    this.addToHistory(query);

    // Handle commands
    if (query.startsWith(':')) {
      const parts = query.substring(1).split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1).join(' ') || null;
      
      if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') {
        process.exit(0);
      }
      
      if (cmd === 'help') {
        this.lastDisplayedType = 'result'; // Mark that we have content to view
        this.resultsBox.setContent(this.getHelpText());
        this.screen.render();
        return;
      }
      
      if (cmd === 'show') {
        this.displayManager.displayResult(appState.jsonData, null);
        return;
      }
      
      if (cmd === 'paths') {
        this.lastDisplayedType = 'result'; // Mark that we have content to view
        const pathsList = appState.allPaths.join('\n');
        const w = this.wrapColor.bind(this);
        this.resultsBox.setContent(`${w('All Paths:', 'info')}\n\n${pathsList}`);
        this.screen.render();
        return;
      }
      
      if (cmd === 'copy' || cmd === 'c') {
        this.copyToClipboard().catch(err => {
          const w = this.wrapColor.bind(this);
          this.resultsBox.setContent(w(`❌ Error: ${err.message}`, 'error'));
          this.screen.render();
        });
        return;
      }
      
      if (cmd === 'copy-query' || cmd === 'cq') {
        this.copyQueryToClipboard().catch(err => {
          const w = this.wrapColor.bind(this);
          this.resultsBox.setContent(w(`❌ Error: ${err.message}`, 'error'));
          this.screen.render();
        });
        return;
      }
      
      if (cmd === 'copy-results' || cmd === 'cr') {
        this.copyResultsToClipboard().catch(err => {
          const w = this.wrapColor.bind(this);
          this.resultsBox.setContent(w(`❌ Error: ${err.message}`, 'error'));
          this.screen.render();
        });
        return;
      }
      
      if (cmd === 'raw') {
        this.enterRawMode();
        return;
      }
      
      if (cmd === 'decode') {
        this.decodeResult();
        return;
      }
      
      if (cmd === 'parse') {
        this.parseResult();
        return;
      }
      
      if (cmd === 'save') {
        this.handleSaveCommand(args);
        return;
      }
      
      if (cmd === 'saveline' || cmd === 'sl') {
        this.handleSaveLineCommand(args);
        return;
      }
      
      if (cmd === 'dump' || cmd === 'export') {
        this.handleDumpCommand(args);
        return;
      }
      
      // Keybinding commands
      if (cmd === 'keybindings' || cmd === 'keys') {
        this.handleKeybindingsCommand(args);
        return;
      }
      
      if (cmd === 'bind') {
        this.handleBindCommand(args);
        return;
      }
      
      if (cmd === 'unbind') {
        this.handleUnbindCommand(args);
        return;
      }
      
      if (cmd === 'reset-keys') {
        this.handleResetKeysCommand(args);
        return;
      }
      
      // Unknown command
      const w = this.wrapColor.bind(this);
      this.resultsBox.setContent(
        w(`❌ Unknown command: :${cmd}`, 'error') + '\n\n' +
        w('Type :help or press F1 to see available commands', 'dim')
      );
      this.screen.render();
      return;
    }

    // Handle search
    if (query.startsWith('//')) {
      // Search within current result
      const searchTerm = query.substring(2);
      this.handleSearchInResult(searchTerm);
      return;
    }
    
    if (query.startsWith('/')) {
      // Search full JSON
      const searchTerm = query.substring(1);
      this.handleSearch(searchTerm);
      return;
    }

    // Handle navigation within search matches (when viewing a single result with highlights)
    if (this.searchMatches.length > 0) {
      if (query === 'n') {
        this.navigateToNextMatch();
        return;
      }
      
      if (query === 'p') {
        this.navigateToPrevMatch();
        return;
      }
    }

    // Handle pagination
    if (appState.lastSearchResults.length > 0) {
      if (query === 'n') {
        if (appState.nextSearchPage()) {
          this.displayManager.displaySearchResults();
        } else {
          const w = this.wrapColor.bind(this);
          this.resultsBox.setContent(w('⚠️  Already on last page', 'warning'));
          this.screen.render();
        }
        return;
      }
      
      if (query === 'p') {
        if (appState.prevSearchPage()) {
          this.displayManager.displaySearchResults();
        } else {
          const w = this.wrapColor.bind(this);
          this.resultsBox.setContent(w('⚠️  Already on first page', 'warning'));
          this.screen.render();
        }
        return;
      }
      
      // Numbered selection from search results
      if (/^\d+$/.test(query)) {
        const num = parseInt(query, 10);
        const index = num - 1;
        if (index >= 0 && index < appState.lastSearchResults.length) {
          const selectedPath = appState.lastSearchResults[index].path;
          const result = this.queryExecutor.execute(selectedPath);
          if (result.success) {
            appState.setLastResult(result.data, selectedPath);
            this.displayManager.displayResult(result.data, selectedPath);
          }
        }
        return;
      }
    }
    
    // Numbered selection from wildcard results
    if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults && /^\d+$/.test(query)) {
      const num = parseInt(query, 10);
      const index = num - 1;
      if (index >= 0 && index < this.lastWildcardResults.length) {
        const selectedItem = this.lastWildcardResults[index];
        const selectedPath = QueryExecutor.pathArrayToString(selectedItem.path);
        const result = this.queryExecutor.execute(selectedPath);
        if (result.success) {
          appState.setLastResult(result.data, selectedPath);
          this.displayManager.displayResult(result.data, selectedPath);
        }
      }
      return;
    }

    // Store the last query for :copy-query command (only for actual queries, not commands)
    this.lastQuery = query;
    
    // Parse query for label syntax and where filter
    const { mainQuery, labelQuery, whereFilter } = this.parseQueryWithLabel(query);

    // Execute JSONPath query
    const result = this.queryExecutor.execute(mainQuery);
    if (result.success) {
      appState.setLastResult(result.data, mainQuery);
      if (result.isWildcard && Array.isArray(result.data)) {
        // Smart filtering: if user is filtering on a field but queried the field itself,
        // automatically query the parent object and filter on that
        let actualResults = result.data;
        let actualQuery = mainQuery;
        let displayFieldName = null;
        
        if (whereFilter && result.data.length > 0) {
          // Check if results are primitives (not objects)
          const firstResult = result.data[0];
          const isPrimitive = typeof firstResult.value !== 'object' || firstResult.value === null;
          
          if (isPrimitive) {
            // Extract the field name from the where filter
            const fieldMatch = whereFilter.match(/^([a-zA-Z_$][\w]*)/);
            if (fieldMatch) {
              const fieldName = fieldMatch[1];
              
              // Try to construct parent query by removing the last field access
              // Handle both $.path.to.field and $.path.to[*].field patterns
              let parentQuery = mainQuery;
              
              // Remove the field from the end
              if (parentQuery.endsWith(`.${fieldName}`)) {
                parentQuery = parentQuery.substring(0, parentQuery.length - fieldName.length - 1);
              } else if (parentQuery.endsWith(`['${fieldName}']`)) {
                parentQuery = parentQuery.substring(0, parentQuery.length - fieldName.length - 4);
              } else if (parentQuery.endsWith(`["${fieldName}"]`)) {
                parentQuery = parentQuery.substring(0, parentQuery.length - fieldName.length - 4);
              }
              
              // Re-execute with parent query
              const parentResult = this.queryExecutor.execute(parentQuery);
              if (parentResult.success && parentResult.isWildcard && Array.isArray(parentResult.data)) {
                // Check if first result is now an object
                if (parentResult.data.length > 0 && typeof parentResult.data[0].value === 'object') {
                  actualResults = parentResult.data;
                  actualQuery = parentQuery;
                  displayFieldName = fieldName; // Remember to extract this field after filtering
                }
              }
            }
          }
        }
        
        this.displayManager.displayWildcardResults(actualResults, actualQuery, labelQuery, whereFilter, displayFieldName);
      } else {
        this.displayManager.displayResult(result.data, mainQuery);
      }
    } else {
      const w = this.wrapColor.bind(this);
      this.resultsBox.setContent(`${w('❌ No results found', 'error')}\n\nQuery: ${mainQuery}`);
      this.screen.render();
    }
  }

  navigateToNextMatch() {
    const w = this.wrapColor.bind(this);
    
    if (this.searchMatches.length === 0) return;
    
    if (this.currentMatchIndex < this.searchMatches.length - 1) {
      this.currentMatchIndex++;
    }
    
    // Get match line and update display
    const matchLine = this.searchMatches[this.currentMatchIndex];
    const total = this.searchMatches.length;
    
    // Update the header to show current match
    const currentContent = this.resultsBox.getContent();
    const lines = currentContent.split('\n');
    if (lines.length > 0) {
      lines[0] = lines[0].replace(/\(Press.*?\)|Match \d+\/\d+ - .*?\)/, 
        `(Match ${this.currentMatchIndex + 1}/${total} - 'n' next, 'p' prev)`);
      this.resultsBox.setContent(lines.join('\n'));
    }
    
    // Calculate scroll position to center the match in view
    // matchLine is the index in the formatted JSON (0-based)
    // We need to add 2 for the header lines we prepend
    const lineInDisplay = matchLine + 2;
    const boxHeight = this.resultsBox.height - 2; // Subtract borders
    const currentScroll = this.resultsBox.getScroll();
    
    // Calculate if match is outside visible area
    const topOfView = currentScroll;
    const bottomOfView = currentScroll + boxHeight;
    
    let newScroll = currentScroll;
    
    if (lineInDisplay < topOfView) {
      // Match is above visible area - scroll up to show it near top
      newScroll = Math.max(0, lineInDisplay - 2);
    } else if (lineInDisplay >= bottomOfView) {
      // Match is below visible area - scroll down to show it near bottom
      newScroll = Math.max(0, lineInDisplay - boxHeight + 3);
    } else {
      // Match is already visible - scroll to center it
      newScroll = Math.max(0, lineInDisplay - Math.floor(boxHeight / 2));
    }
    
    this.resultsBox.setScroll(newScroll);
    this.screen.render();
  }

  navigateToPrevMatch() {
    const w = this.wrapColor.bind(this);
    
    if (this.searchMatches.length === 0) return;
    
    if (this.currentMatchIndex > 0) {
      this.currentMatchIndex--;
    }
    
    // Get match line and update display
    const matchLine = this.searchMatches[this.currentMatchIndex];
    const total = this.searchMatches.length;
    
    // Update the header to show current match
    const currentContent = this.resultsBox.getContent();
    const lines = currentContent.split('\n');
    if (lines.length > 0) {
      lines[0] = lines[0].replace(/\(Press.*?\)|Match \d+\/\d+ - .*?\)/, 
        `(Match ${this.currentMatchIndex + 1}/${total} - 'n' next, 'p' prev)`);
      this.resultsBox.setContent(lines.join('\n'));
    }
    
    // Calculate scroll position to center the match in view
    // matchLine is the index in the formatted JSON (0-based)
    // We need to add 2 for the header lines we prepend
    const lineInDisplay = matchLine + 2;
    const boxHeight = this.resultsBox.height - 2; // Subtract borders
    const currentScroll = this.resultsBox.getScroll();
    
    // Calculate if match is outside visible area
    const topOfView = currentScroll;
    const bottomOfView = currentScroll + boxHeight;
    
    let newScroll = currentScroll;
    
    if (lineInDisplay < topOfView) {
      // Match is above visible area - scroll up to show it near top
      newScroll = Math.max(0, lineInDisplay - 2);
    } else if (lineInDisplay >= bottomOfView) {
      // Match is below visible area - scroll down to show it near bottom
      newScroll = Math.max(0, lineInDisplay - boxHeight + 3);
    } else {
      // Match is already visible - scroll to center it
      newScroll = Math.max(0, lineInDisplay - Math.floor(boxHeight / 2));
    }
    
    this.resultsBox.setScroll(newScroll);
    this.screen.render();
  }

  handleSearch(searchTerm) {
    if (!searchTerm) {
      const w = this.wrapColor.bind(this);
      this.resultsBox.setContent(w('⚠️  Enter a search term after /', 'warning'));
      appState.clearLastSearchResults();
      this.screen.render();
      return;
    }

    const matches = this.searchEngine.searchInJSON(searchTerm);

    if (matches.length === 0) {
      const w = this.wrapColor.bind(this);
      this.resultsBox.setContent(w(`❌ No matches found for: "${searchTerm}"`, 'error'));
      appState.clearLastSearchResults();
      this.screen.render();
      return;
    }

    appState.setLastSearchResults(matches);
    this.displayManager.displaySearchResults();
  }

  handleSearchInResult(searchTerm) {
    const w = this.wrapColor.bind(this);
    
    if (!searchTerm || searchTerm.trim() === '') {
      this.resultsBox.setContent(w('⚠️  Enter a search term after //', 'warning'));
      appState.clearLastSearchResults();
      this.screen.render();
      return;
    }
    
    // Trim the search term to ignore leading/trailing spaces
    searchTerm = searchTerm.trim();

    // Check if we're viewing a single selected item
    if (this.lastDisplayedType === 'result' && appState.lastDisplayedResult) {
      // We're viewing a selected item - search and highlight within it
      const basePath = appState.lastDisplayedPath || '$';
      
      // Format the result with highlighting
      const formatted = Formatter.prettyPrint(appState.lastDisplayedResult);
      const lines = formatted.split('\n');
      
      // Search for the term in the formatted output (case-insensitive)
      const searchLower = searchTerm.toLowerCase();
      const matchLines = []; // Track which lines have matches
      let matchCount = 0;
      
      const highlightedLines = lines.map((line, index) => {
        const lineLower = line.toLowerCase();
        if (lineLower.includes(searchLower)) {
          matchLines.push(index);
          matchCount++;
          
          // Highlight the search term in the line
          // Use a case-insensitive replace
          const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          return line.replace(regex, `{yellow-bg}{black-fg}$1{/black-fg}{/yellow-bg}`);
        }
        return line;
      });

      if (matchCount === 0) {
        this.resultsBox.setContent(
          w(`❌ No matches found for: "${searchTerm}" in current result`, 'error') + '\n\n' +
          w(`Searching within: ${basePath}`, 'dim')
        );
        this.searchMatches = [];
        this.screen.render();
        return;
      }

      // Store match positions for n/p navigation
      this.searchMatches = matchLines;
      this.currentMatchIndex = 0;

      // Build the content with header
      let content = w(`✓ Found ${matchCount} match${matchCount === 1 ? '' : 'es'} for "${searchTerm}"`, 'success');
      content += ` ${w(`in ${basePath}`, 'dim')}`;
      if (matchCount > 1) {
        content += ` ${w(`(Press 'n' for next, 'p' for previous)`, 'dim')}`;
      }
      content += '\n\n';
      content += highlightedLines.join('\n');

      this.resultsBox.setContent(content);
      
      // Scroll to the first match
      // Add 2 for the header lines
      const scrollToLine = this.searchMatches[0] + 2;
      this.resultsBox.setScroll(Math.max(0, scrollToLine - 2)); // Show a couple lines of context above
      
      this.screen.render();
    } 
    // Check if we're viewing wildcard results - search within those results
    else if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults && this.lastWildcardResults.length > 0) {
      // Search within wildcard results and filter to matching items
      const matches = this.lastWildcardResults.filter(item => {
        const valueStr = typeof item.value === 'object' ? JSON.stringify(item.value) : String(item.value);
        return valueStr.toLowerCase().includes(searchTerm.toLowerCase());
      });

      if (matches.length === 0) {
        this.resultsBox.setContent(
          w(`❌ No matches found for: "${searchTerm}" in ${this.lastWildcardResults.length} results`, 'error')
        );
        this.screen.render();
        return;
      }

      // Display filtered wildcard results with custom header
      const basePath = appState.lastDisplayedPath || '$';
      this.displayManager.displayWildcardResults(
        matches, 
        basePath, 
        null, 
        null, 
        null, 
        `Found ${matches.length}/${this.lastWildcardResults.length} matches for "${searchTerm}"`
      );
    } 
    else {
      // Not viewing any results - default to full JSON search (same as /)
      this.handleSearch(searchTerm);
    }
  }

  // Display methods moved to lib/tui/display.js (DisplayManager)

  handleResize() {
    // Only adjust if help is visible
    if (this.helpVisible) {
      const terminalHeight = process.stdout.rows || 24;
      const isCompact = terminalHeight < 30;
      
      // Update info box height and content
      this.infoBox.height = isCompact ? '20%' : '40%';
      this.infoBox.setContent(this.getHelpText(false));
      this.infoBox.setLabel(' Info & Commands ');
      
      // Update suggestions box position and height
      this.suggestionsBox.top = isCompact ? '20%' : '40%';
      this.suggestionsBox.height = isCompact ? '80%-3' : '60%-3';
    } else {
      // Keep help hidden and suggestions full height
      this.infoBox.height = 0;
      this.infoBox.hide();
      this.suggestionsBox.top = 0;
      this.suggestionsBox.height = '100%-3';
    }
    
    // Re-render the screen
    this.screen.render();
  }

  addToHistory(command) {
    if (!command || command.trim() === '') return;
    
    if (this.commandHistory.length > 0 && 
        this.commandHistory[this.commandHistory.length - 1] === command) {
      return;
    }
    
    this.commandHistory.push(command);
    if (this.commandHistory.length > config.historySize) {
      this.commandHistory.shift();
    }
    this.historyIndex = this.commandHistory.length;
  }

  async copyToClipboard() {
    const w = this.wrapColor.bind(this);
    let dataToCopy = null;
    let description = '';
    
    // Determine what to copy based on display type
    if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults) {
      // Copy wildcard results as an array of objects
      dataToCopy = this.lastWildcardResults.map(item => ({
        path: QueryExecutor.pathArrayToString(item.path),
        value: item.value
      }));
      description = `${this.lastWildcardResults.length} wildcard results`;
    } else if (this.lastDisplayedType === 'search' && appState.lastSearchResults.length > 0) {
      // Copy search results as an array of matches
      dataToCopy = appState.lastSearchResults.map(match => ({
        path: match.path,
        value: match.value,
        preview: match.preview
      }));
      description = `${appState.lastSearchResults.length} search results`;
    } else if (appState.lastDisplayedResult) {
      // Copy the last displayed result
      dataToCopy = appState.lastDisplayedResult;
      description = 'result';
    } else {
      this.resultsBox.setContent(w('⚠️  No result to copy. Run a query first.', 'warning'));
      this.screen.render();
      return;
    }
    
    // Check if clipboard is supported
    if (!ClipboardManager.isSupported()) {
      this.resultsBox.setContent(w('❌ Clipboard copy not supported on this platform', 'error'));
      this.screen.render();
      return;
    }
    
    // Determine how to format the data for copying
    let copyString;
    if (typeof dataToCopy === 'string') {
      // Copy strings without quotes
      copyString = dataToCopy;
    } else if (typeof dataToCopy === 'number' || typeof dataToCopy === 'boolean' || dataToCopy === null) {
      // Copy primitives as-is
      copyString = String(dataToCopy);
    } else {
      // Copy objects/arrays as formatted JSON
      copyString = JSON.stringify(dataToCopy, null, 2);
    }
    
    try {
      await ClipboardManager.copyToClipboard(copyString);
      this.resultsBox.setContent(
        `${w('✓ Copied to clipboard!', 'success')}\n\n` +
        `${w(`Copied: ${description}`, 'info')}\n` +
        `${w(`Size: ${copyString.length} bytes`, 'dim')}\n\n` +
        `${w('You can now paste with Cmd+V (Mac) or Ctrl+V', 'dim')}`
      );
    } catch (error) {
      this.resultsBox.setContent(w(`❌ Failed to copy: ${error.message}`, 'error'));
    }
    this.screen.render();
  }
  
  async copyQueryToClipboard() {
    const w = this.wrapColor.bind(this);
    
    if (!this.lastQuery) {
      this.resultsBox.setContent(w('⚠️  No query to copy. Run a query first.', 'warning'));
      this.screen.render();
      return;
    }
    
    if (!ClipboardManager.isSupported()) {
      this.resultsBox.setContent(w('❌ Clipboard copy not supported on this platform', 'error'));
      this.screen.render();
      return;
    }
    
    try {
      await ClipboardManager.copyToClipboard(this.lastQuery);
      this.resultsBox.setContent(
        `${w('✓ Query copied to clipboard!', 'success')}\n\n` +
        `${w('Query:', 'info')}\n` +
        `${this.lastQuery}\n\n` +
        `${w('You can now paste with Cmd+V (Mac) or Ctrl+V', 'dim')}`
      );
    } catch (error) {
      this.resultsBox.setContent(w(`❌ Failed to copy: ${error.message}`, 'error'));
    }
    this.screen.render();
  }
  
  async copyResultsToClipboard() {
    const w = this.wrapColor.bind(this);
    
    if (this.lastDisplayedType !== 'wildcard' || !this.lastDisplayedLabels || this.lastDisplayedLabels.length === 0) {
      this.resultsBox.setContent(w('⚠️  No wildcard results to copy. This command only works with wildcard queries.', 'warning'));
      this.screen.render();
      return;
    }
    
    if (!ClipboardManager.isSupported()) {
      this.resultsBox.setContent(w('❌ Clipboard copy not supported on this platform', 'error'));
      this.screen.render();
      return;
    }
    
    // Use the stored displayed labels (exactly what user sees in TUI)
    const lines = this.lastDisplayedLabels.map(item => `${item.label} → ${item.value}`);
    const copyString = lines.join('\n');
    
    try {
      await ClipboardManager.copyToClipboard(copyString);
      this.resultsBox.setContent(
        `${w('✓ Results copied to clipboard!', 'success')}\n\n` +
        `${w(`Copied: ${this.lastDisplayedLabels.length} results (labels → values)`, 'info')}\n` +
        `${w(`Size: ${copyString.length} bytes`, 'dim')}\n\n` +
        `${w('Format: label → value (one per line)', 'dim')}\n` +
        `${w('You can now paste with Cmd+V (Mac) or Ctrl+V', 'dim')}`
      );
    } catch (error) {
      this.resultsBox.setContent(w(`❌ Failed to copy: ${error.message}`, 'error'));
    }
    this.screen.render();
  }
  
  enterRawMode() {
    let dataToDisplay = null;
    let description = '';
    
    // Determine what to display based on display type
    if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults) {
      dataToDisplay = this.lastWildcardResults.map(item => ({
        path: QueryExecutor.pathArrayToString(item.path),
        value: item.value
      }));
      description = `${this.lastWildcardResults.length} wildcard results`;
    } else if (this.lastDisplayedType === 'search' && appState.lastSearchResults.length > 0) {
      dataToDisplay = appState.lastSearchResults.map(match => ({
        path: match.path,
        value: match.value
      }));
      description = `${appState.lastSearchResults.length} search results`;
    } else if (appState.lastDisplayedResult) {
      dataToDisplay = appState.lastDisplayedResult;
      description = 'result';
    } else {
      const w = this.wrapColor.bind(this);
      this.resultsBox.setContent(w('⚠️  No result to display. Run a query first.', 'warning'));
      this.screen.render();
      return;
    }
    
    // Destroy the screen to restore terminal
    this.screen.destroy();
    
    // Print the result in plain text
    const jsonString = JSON.stringify(dataToDisplay, null, 2);
    console.log('\n' + '='.repeat(80));
    console.log(`RAW MODE - You can now select and copy text with your mouse`);
    console.log(`Displaying: ${description}`);
    console.log('='.repeat(80) + '\n');
    
    console.log(jsonString);
    console.log('\n' + '='.repeat(80));
    console.log('Press Enter to return to TUI mode...');
    console.log('='.repeat(80) + '\n');
    
    // Wait for user to press Enter using /dev/tty
    const readline = require('readline');
    const fs = require('fs');
    const tty = require('tty');
    
    try {
      const fd = fs.openSync('/dev/tty', 'r+');
      const ttyInput = new tty.ReadStream(fd);
      const ttyOutput = new tty.WriteStream(fd);
      
      const rl = readline.createInterface({
        input: ttyInput,
        output: ttyOutput
      });
      
      rl.question('', () => {
        rl.close();
        ttyInput.destroy();
        ttyOutput.destroy();
        
        // Reinitialize the TUI
        this.init();
        this.loadJSON(appState.jsonData);
        
        // Restore the last display
        if (this.lastDisplayedType === 'wildcard' && this.lastWildcardResults) {
          const result = this.queryExecutor.execute(appState.lastDisplayedPath);
          if (result.success && result.isWildcard) {
            this.displayManager.displayWildcardResults(this.lastWildcardResults, result.basePath);
          }
        } else if (this.lastDisplayedType === 'search' && appState.lastSearchResults.length > 0) {
          this.displayManager.displaySearchResults();
        } else if (appState.lastDisplayedPath) {
          this.displayManager.displayResult(appState.lastDisplayedResult, appState.lastDisplayedPath);
        }
      });
    } catch (error) {
      console.error('Failed to open TTY for raw mode:', error);
      process.exit(0);
    }
  }
  
  handlePromptResponse(ch) {
    if (!this.waitingForPrompt) return;
    
    const response = ch.toLowerCase();
    
    // Clear prompt state
    this.waitingForPrompt = false;
    const type = this.promptType;
    this.promptType = null;
    
    if (response === 'y') {
      // User wants to decode/parse
      if (type === 'decode') {
        this.decodeResult();
      } else if (type === 'parse') {
        this.parseResult();
      }
    } else {
      // User declined - redisplay without prompt
      this.displayManager.displayResult(appState.lastDisplayedResult, appState.lastDisplayedPath, true);
    }
  }
  
  decodeResult() {
    const w = this.wrapColor.bind(this);
    
    if (!appState.lastDisplayedResult) {
      this.resultsBox.setContent(w('❌ No result to decode. Execute a query first.', 'error'));
      this.screen.render();
      return;
    }
    
    // Decode the result
    const decoded = TextUtils.decodeURIData(appState.lastDisplayedResult);
    
    // Update the stored result
    appState.setLastResult(decoded, appState.lastDisplayedPath);
    
    // Redisplay with decoded data (this will NOT prompt again)
    const w2 = this.wrapColor.bind(this);
    let content = '';
    if (appState.lastDisplayedPath) {
      content += `${w2('✓ Result for:', 'success')} ${w2(appState.lastDisplayedPath, 'path')}\n\n`;
    }
    const formatted = Formatter.prettyPrint(decoded);
    content += formatted;
    this.resultsBox.setContent(content);
    this.resultsBox.setScrollPerc(0);
    this.screen.render();
  }
  
  parseResult() {
    const w = this.wrapColor.bind(this);
    
    if (!appState.lastDisplayedResult) {
      this.resultsBox.setContent(w('❌ No result to parse. Execute a query first.', 'error'));
      this.screen.render();
      return;
    }
    
    // Parse the result
    const parsed = TextUtils.parseJSONData(appState.lastDisplayedResult);
    
    // Update the stored result
    appState.setLastResult(parsed, appState.lastDisplayedPath);
    
    // Redisplay with parsed data (this will NOT prompt again)
    const w2 = this.wrapColor.bind(this);
    let content = '';
    if (appState.lastDisplayedPath) {
      content += `${w2('✓ Result for:', 'success')} ${w2(appState.lastDisplayedPath, 'path')}\n\n`;
    }
    const formatted = Formatter.prettyPrint(parsed);
    content += formatted;
    this.resultsBox.setContent(content);
    this.resultsBox.setScrollPerc(0);
    this.screen.render();
  }

  loadJSON(jsonData) {
    appState.setJsonData(jsonData);
    
    const w = this.wrapColor.bind(this);
    
    // Estimate size and choose extraction strategy
    const sizeInfo = PathExtractor.estimateSize(jsonData);
    let extractionMessage = '';
    let paths = [];
    
    if (sizeInfo.isVeryLarge) {
      // For very large files (25+ MB), use optimized extraction for suggestions
      this.resultsBox.setContent(
        `${w('⏳ Loading large JSON file...', 'warning')}\n\n` +
        `${w(`Size: ${sizeInfo.sizeMB.toFixed(2)} MB`, 'info')}\n` +
        `${w('Extracting paths for suggestions (this may take a moment)...', 'dim')}`
      );
      this.screen.render();
      
      // Extract enough paths for useful suggestions (depth 3, min 200 paths)
      paths = PathExtractor.extractPathsLazy(jsonData, 3, 200);
      extractionMessage = `\n${w('⚠️  Large file detected - showing limited paths', 'warning')}\n${w('   Type a query to explore deeper paths or use wildcards', 'dim')}`;
    } else if (sizeInfo.isLarge) {
      // For large files (5-25 MB), use limited extraction
      this.resultsBox.setContent(
        `${w('⏳ Loading JSON file...', 'info')}\n\n` +
        `${w(`Size: ${sizeInfo.sizeMB.toFixed(2)} MB`, 'info')}\n` +
        `${w('Extracting paths (this may take a moment)...', 'dim')}`
      );
      this.screen.render();
      
      paths = PathExtractor.extractPaths(jsonData, '$', { 
        maxDepth: 4, 
        maxArrayItems: 10,
        maxPaths: 50000 // Limit to 50k paths
      });
    } else {
      // Small files, extract all paths
      paths = PathExtractor.extractPaths(jsonData);
    }
    
    appState.setAllPaths(paths);
    
    // Show initial suggestions IMMEDIATELY (before showing success message)
    // This ensures users see suggestions right away
    this.updateSuggestions('');
    
    this.resultsBox.setContent(
      `${w('✓ JSON loaded successfully!', 'success')}\n\n` +
      `${w('Paths extracted:', 'info')} ${paths.length}${sizeInfo.isLarge ? ' (limited)' : ''}\n` +
      `${w(`Size: ${sizeInfo.sizeMB.toFixed(2)} MB`, 'dim')}` +
      extractionMessage +
      `\n\n${w('Type a query to start exploring...', 'dim')}\n` +
      `${w('💡 Suggestions are shown on the left - start typing to filter!', 'info')}`
    );
    
    this.screen.render();
  }
  
  handleSaveCommand(filename) {
    const w = this.wrapColor.bind(this);
    
    if (appState.lastDisplayedResult === null) {
      this.resultsBox.setContent(w('❌ No result to save. Query something first.', 'error'));
      this.screen.render();
      return;
    }
    
    try {
      const fullPath = FileManager.saveToFile(appState.lastDisplayedResult, filename, 'jojq-result');
      this.resultsBox.setContent(
        w('✓ Saved result to: ', 'success') + w(fullPath, 'info')
      );
      this.screen.render();
    } catch (error) {
      this.resultsBox.setContent(w(`❌ Error saving file: ${error.message}`, 'error'));
      this.screen.render();
    }
  }
  
  handleSaveLineCommand(filename) {
    const w = this.wrapColor.bind(this);
    
    if (appState.lastDisplayedResult === null || appState.lastDisplayedPath === null) {
      this.resultsBox.setContent(w('❌ No result to save. Query something first.', 'error'));
      this.screen.render();
      return;
    }
    
    try {
      const dataWithLine = {
        path: appState.lastDisplayedPath,
        data: appState.lastDisplayedResult
      };
      const fullPath = FileManager.saveToFile(dataWithLine, filename, 'jojq-result-line');
      this.resultsBox.setContent(
        w('✓ Saved result with line number to: ', 'success') + w(fullPath, 'info')
      );
      this.screen.render();
    } catch (error) {
      this.resultsBox.setContent(w(`❌ Error saving file: ${error.message}`, 'error'));
      this.screen.render();
    }
  }
  
  handleDumpCommand(filename) {
    const w = this.wrapColor.bind(this);
    
    try {
      const fullPath = FileManager.saveToFile(appState.jsonData, filename, 'jojq-dump');
      this.resultsBox.setContent(
        w('✓ Dumped full JSON to: ', 'success') + w(fullPath, 'info')
      );
      this.screen.render();
    } catch (error) {
      this.resultsBox.setContent(w(`❌ Error saving file: ${error.message}`, 'error'));
      this.screen.render();
    }
  }
  
  handleKeybindingsCommand(args) {
    const w = this.wrapColor.bind(this);
    
    if (!args) {
      // Show all keybindings
      const formatted = keybindingsManager.formatKeybindings(true);
      this.resultsBox.setContent(
        w('Current Keybindings:', 'info') + '\n' +
        w('(Custom bindings are marked [CUSTOM])', 'dim') + '\n' +
        formatted + '\n\n' +
        w('Commands:', 'info') + '\n' +
        w('  :keys                 Show all keybindings', 'dim') + '\n' +
        w('  :bind <cmd> <key>     Add keybinding', 'dim') + '\n' +
        w('  :unbind <cmd> <key>   Remove keybinding', 'dim') + '\n' +
        w('  :reset-keys [cmd]     Reset to defaults', 'dim')
      );
    } else if (args === 'export') {
      // Export keybindings to file
      const filename = pathModule.join(os.homedir(), 'jojq-keybindings-backup.json');
      if (keybindingsManager.exportKeybindings(filename)) {
        this.resultsBox.setContent(
          w('✓ Keybindings exported to: ', 'success') + w(filename, 'info')
        );
      } else {
        this.resultsBox.setContent(w('❌ Failed to export keybindings', 'error'));
      }
    } else {
      // Show keybindings for specific command
      const keys = keybindingsManager.getKeybindings(args);
      if (keys.length > 0) {
        this.resultsBox.setContent(
          w(`Keybindings for "${args}":`, 'info') + '\n' +
          keys.map(k => `  ${w(k, 'highlight')}`).join('\n')
        );
      } else {
        this.resultsBox.setContent(w(`❌ No keybindings found for command: ${args}`, 'error'));
      }
    }
    
    this.screen.render();
  }
  
  handleBindCommand(args) {
    const w = this.wrapColor.bind(this);
    
    if (!args || !args.includes(' ')) {
      this.resultsBox.setContent(
        w('Usage: :bind <command> <key>', 'error') + '\n\n' +
        w('Examples:', 'info') + '\n' +
        w('  :bind copy :cp', 'dim') + '\n' +
        w('  :bind exit :x', 'dim') + '\n' +
        w('  :bind help f2', 'dim')
      );
      this.screen.render();
      return;
    }
    
    const parts = args.split(' ');
    const command = parts[0];
    const key = parts.slice(1).join(' ');
    
    const result = keybindingsManager.addKeybinding(command, key);
    
    if (result.success) {
      this.resultsBox.setContent(
        w('✓ Keybinding added!', 'success') + '\n\n' +
        w(`Command: ${command}`, 'info') + '\n' +
        w(`Key: ${key}`, 'info') + '\n\n' +
        w('Current bindings: ', 'dim') +
        keybindingsManager.getKeybindings(command).map(k => w(k, 'highlight')).join(', ')
      );
    } else if (result.conflicts.length > 0) {
      this.resultsBox.setContent(
        w('❌ Conflict detected!', 'error') + '\n\n' +
        w(`Key "${key}" is already bound to:`, 'warning') + '\n' +
        result.conflicts.map(c => `  ${c.command} (${c.key})`).join('\n') + '\n\n' +
        w('Use :unbind first or choose a different key', 'dim')
      );
    } else {
      this.resultsBox.setContent(w('❌ Failed to add keybinding', 'error'));
    }
    
    this.screen.render();
  }
  
  handleUnbindCommand(args) {
    const w = this.wrapColor.bind(this);
    
    if (!args || !args.includes(' ')) {
      this.resultsBox.setContent(
        w('Usage: :unbind <command> <key>', 'error') + '\n\n' +
        w('Examples:', 'info') + '\n' +
        w('  :unbind copy :cp', 'dim') + '\n' +
        w('  :unbind exit :x', 'dim')
      );
      this.screen.render();
      return;
    }
    
    const parts = args.split(' ');
    const command = parts[0];
    const key = parts.slice(1).join(' ');
    
    const result = keybindingsManager.removeKeybinding(command, key);
    
    if (result.success) {
      this.resultsBox.setContent(
        w('✓ Keybinding removed!', 'success') + '\n\n' +
        w(`Command: ${command}`, 'info') + '\n' +
        w(`Key: ${key}`, 'info') + '\n\n' +
        w('Remaining bindings: ', 'dim') +
        keybindingsManager.getKeybindings(command).map(k => w(k, 'highlight')).join(', ')
      );
    } else {
      this.resultsBox.setContent(
        w(`❌ ${result.error || 'Failed to remove keybinding'}`, 'error')
      );
    }
    
    this.screen.render();
  }
  
  handleResetKeysCommand(args) {
    const w = this.wrapColor.bind(this);
    
    if (!args) {
      // Reset all keybindings
      if (keybindingsManager.resetToDefaults()) {
        this.resultsBox.setContent(
          w('✓ All keybindings reset to defaults!', 'success') + '\n\n' +
          w('Use :keys to see current keybindings', 'dim')
        );
      } else {
        this.resultsBox.setContent(w('❌ Failed to reset keybindings', 'error'));
      }
    } else {
      // Reset specific command
      if (keybindingsManager.resetCommand(args)) {
        this.resultsBox.setContent(
          w(`✓ Keybindings for "${args}" reset to defaults!`, 'success') + '\n\n' +
          w('Default bindings: ', 'dim') +
          keybindingsManager.getKeybindings(args).map(k => w(k, 'highlight')).join(', ')
        );
      } else {
        this.resultsBox.setContent(w(`❌ Failed to reset keybindings for: ${args}`, 'error'));
      }
    }
    
    this.screen.render();
  }
}

// Main execution
async function main() {
  // Check if we're in proxy mode
  const args = {
    proxy: process.argv.includes('--proxy'),
    proxyPort: 8888,
    insecure: process.argv.includes('--insecure'),
    cli: process.argv.includes('--cli')
  };

  // Find port if specified
  const portIndex = process.argv.indexOf('--proxy');
  if (portIndex !== -1 && process.argv[portIndex + 1] && !process.argv[portIndex + 1].startsWith('--')) {
    args.proxyPort = parseInt(process.argv[portIndex + 1], 10);
  }

  // Proxy mode
  if (args.proxy) {
    const ProxyServer = require('./lib/proxy').ProxyServer;
    const proxyServer = new ProxyServer(args.proxyPort, args.insecure);
    await proxyServer.initialize();
    proxyServer.start(true);
    return;
  }

  // CLI mode (fallback to old version)
  if (args.cli) {
    require('./index.cli.js');
    return;
  }

  // TUI mode (default)
  // Check if we have piped input
  const hasInput = !process.stdin.isTTY;
  
  if (!hasInput) {
    console.error('Error: No JSON input provided. Pipe JSON data into jojq.');
    console.error('Example: curl https://api.example.com/data | jojq');
    console.error('');
    console.error('Modes:');
    console.error('  cat file.json | jojq        # TUI mode (default)');
    console.error('  cat file.json | jojq --cli  # CLI mode (legacy)');
    console.error('  jojq --proxy 8888           # Proxy mode');
    process.exit(1);
  }

  // Read JSON from stdin first
  let jsonInput = '';
  process.stdin.setEncoding('utf8');
  
  process.stdin.on('data', (chunk) => {
    jsonInput += chunk;
  });

  process.stdin.on('end', () => {
    try {
      const jsonData = JSON.parse(jsonInput);
      
      // Load config
      const loadedConfig = ConfigManager.loadConfig();
      
      // Now that we have the JSON, initialize TUI with /dev/tty
      const tui = new JojqTUI(jsonData);
      tui.init();
      if (!tui.preloadedJSON) {
        tui.loadJSON(jsonData);
      }
    } catch (error) {
      console.error('Error: Invalid JSON input');
      console.error(error.message);
      console.error(error.stack);
      process.exit(1);
    }
  });
}

// Always run main when this file is loaded
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

module.exports = { JojqTUI };

