#!/usr/bin/env node

/**
 * TUI Display Module
 * 
 * Handles all result rendering:
 * - displaySearchResults() - Show search matches
 * - displayWildcardResults() - Show wildcard/filtered results with labels
 * - displayResult() - Show single JSON result
 */

const { QueryExecutor } = require('../query');
const { Formatter } = require('../formatter');

// Simple TUI color scheme (blessed color tags)
const TUI_COLORS = {
  success: 'green-fg',
  error: 'red-fg',
  warning: 'yellow-fg',
  info: 'cyan-fg',
  dim: 'gray-fg',
  path: 'blue-fg',
  key: 'magenta-fg',
  value: 'green-fg',
  number: 'cyan-fg',
  string: 'yellow-fg',
  boolean: 'magenta-fg',
  null: 'gray-fg',
  command: 'cyan-fg',
  highlight: 'yellow-fg'
};

class DisplayManager {
  constructor(tui, appState) {
    this.tui = tui;
    this.appState = appState;
  }
  
  // Helper to wrap text with blessed color tag
  wrapColor(text, type) {
    const colorTag = TUI_COLORS[type];
    if (!colorTag) {
      return text;
    }
    return `{${colorTag}}${text}{/${colorTag}}`;
  }
  
  /**
   * Display search results (from / command)
   */
  displaySearchResults() {
    // Store for copying
    this.tui.lastDisplayedType = 'search';
    this.tui.lastWildcardResults = null;
    this.tui.searchMatches = []; // Clear search matches when showing search results
    
    const w = this.wrapColor.bind(this);
    const warning = TUI_COLORS.warning;
    const pathColor = TUI_COLORS.path;
    
    const pageInfo = this.appState.getSearchPageInfo();
    const pagedResults = this.appState.getPagedSearchResults();

    let content = w(`✓ Found ${pageInfo.total} matches`, 'success');
    if (pageInfo.totalPages > 1) {
      content += ` ${w(`(Page ${pageInfo.currentPage}/${pageInfo.totalPages})`, 'info')}`;
    }
    content += '\n\n';

    const startNum = this.appState.searchPage * this.appState.searchPageSize + 1;
    pagedResults.forEach((match, index) => {
      const displayNum = startNum + index;
      const isSelected = this.tui.focusedPanel === 'results' && index === this.tui.resultsSelectedIndex;
      
      if (isSelected) {
        // Highlight the selected result
        if (warning && warning !== '') {
          content += `{inverse}{${warning}}▶ [${displayNum}] ${match.path}{/${warning}}{/inverse}\n`;
        } else {
          content += `{inverse}▶ [${displayNum}] ${match.path}{/inverse}\n`;
        }
      } else {
        const numPart = (warning && warning !== '') ? `{${warning}}[${displayNum}]{/${warning}}` : `[${displayNum}]`;
        const pathPart = (pathColor && pathColor !== '') ? `{${pathColor}}${match.path}{/${pathColor}}` : match.path;
        content += `${numPart} ${pathPart}\n`;
      }
      
      const preview = match.preview.length < 80 
        ? match.preview 
        : match.preview.substring(0, 74) + '...';
      
      if (isSelected) {
        content += `{inverse}    → ${preview}{/inverse}\n\n`;
      } else {
        content += `    → ${preview}\n\n`;
      }
    });

    const tip1 = this.tui.focusedPanel === 'results' 
      ? 'Tip: Type number or ↑/↓ to select, Enter to view, ← to return'
      : 'Tip: Type number or → to navigate results panel';
    content += w(tip1, 'dim') + '\n';
    
    if (pageInfo.totalPages > 1) {
      content += w("Tip: 'n' = next page, 'p' = previous page", 'dim');
    }

    this.tui.resultsBox.setContent(content);
    
    // Auto-scroll to keep selected result visible
    if (this.tui.focusedPanel === 'results' && pagedResults.length > 0) {
      const boxHeight = this.tui.resultsBox.height - 2; // Subtract borders
      const currentScroll = this.tui.resultsBox.getScroll();
      // Each result takes 3 lines (number/path + preview + blank line)
      const linesBeforeResults = 2; // Header lines
      const selectedLine = linesBeforeResults + (this.tui.resultsSelectedIndex * 3);
      
      // If selected item is above visible area, scroll up
      if (selectedLine < currentScroll) {
        this.tui.resultsBox.setScroll(selectedLine);
      }
      // If selected item is below visible area, scroll down
      else if (selectedLine >= currentScroll + boxHeight) {
        this.tui.resultsBox.setScroll(selectedLine - boxHeight + 3); // +3 to show full result
      }
    } else {
      this.tui.resultsBox.setScrollPerc(0);
    }
    
    this.tui.screen.render();
  }

  /**
   * Display wildcard results with optional labels and filters
   */
  displayWildcardResults(results, basePath, labelQuery = null, whereFilter = null, displayFieldName = null, customHeader = null) {
    // jsonpath-plus returns paths as strings when using resultType: 'all'
    // We need to convert them back to arrays for label processing
    // Format: "$['field1']['field2'][0]['field3']" -> ['$', 'field1', 'field2', 0, 'field3']
    const resultsWithArrayPaths = results.map(item => {
      if (typeof item.path === 'string') {
        // Convert string path back to array
        const pathArray = this.tui.parsePathString(item.path);
        return { ...item, path: pathArray };
      }
      return item;
    });
    
    // Apply where filter if provided
    const filteredResults = whereFilter 
      ? resultsWithArrayPaths.filter(item => this.tui.evaluateWhereCondition(item.value, item.path, whereFilter))
      : resultsWithArrayPaths;
    
    // If displayFieldName is provided, extract that field from each filtered result
    const finalResults = displayFieldName
      ? filteredResults.map(item => ({
          path: item.path,
          value: item.value && typeof item.value === 'object' ? item.value[displayFieldName] : item.value
        }))
      : filteredResults;
    
    // Store for copying (with array paths, after filtering and field extraction)
    this.tui.lastDisplayedType = 'wildcard';
    this.tui.lastWildcardResults = finalResults;
    this.tui.searchMatches = []; // Clear search matches when showing wildcard results
    
    const w = this.wrapColor.bind(this);
    
    // Clear existing content
    this.tui.resultsBox.setContent('');
    
    // Add header using setContent
    let headerText;
    if (customHeader) {
      headerText = `✓ ${customHeader}`;
    } else if (whereFilter && labelQuery) {
      headerText = `✓ Found ${finalResults.length}/${results.length} matches (filtered, with labels)`;
    } else if (whereFilter) {
      headerText = `✓ Found ${finalResults.length}/${results.length} matches (filtered)`;
    } else if (labelQuery) {
      headerText = `✓ Found ${finalResults.length} matches (with labels)`;
    } else {
      headerText = `✓ Found ${finalResults.length} matches`;
    }
    
    this.tui.resultsBox.setContent(
      w(headerText, 'success') + '\n' +
      w('(Scroll to view all)', 'dim') + '\n'
    );
    
    // Cache for label results to avoid duplicate queries
    const labelCache = {};
    
    // Store displayed labels for copy-results command
    const displayedLabels = [];
    
    // Process each result
    let displayedCount = 0;
    const allLines = [];
    
    for (let idx = 0; idx < finalResults.length; idx++) {
      const item = finalResults[idx];
      let displayPath;
      
      // If labelQuery is provided, resolve it and use as display path
      if (labelQuery) {
        try {
          let absoluteLabelPath;
          
          // Check if label query uses relative paths or wildcards
          if (labelQuery.startsWith('../') || labelQuery.startsWith('./')) {
            // Relative path - resolve from result path
            absoluteLabelPath = this.tui.resolveRelativePath(item.path, labelQuery);
          } else if (labelQuery.includes('[*]')) {
            // Wildcard path - substitute actual indices from result path
            absoluteLabelPath = this.tui.resolveWildcardIndices(item.path, labelQuery);
          } else {
            // Absolute path without wildcards - use as-is
            absoluteLabelPath = labelQuery;
          }
          
          // Check cache first
          let labelValue;
          if (labelCache[absoluteLabelPath]) {
            labelValue = labelCache[absoluteLabelPath];
          } else {
            // Execute the label query to get the label value
            const labelResult = this.tui.queryExecutor.execute(absoluteLabelPath);
          
            if (labelResult.success && labelResult.data !== undefined) {
              // Format label value based on type
              
              if (typeof labelResult.data === 'string') {
                labelValue = labelResult.data;
              } else if (typeof labelResult.data === 'number' || typeof labelResult.data === 'boolean') {
                labelValue = String(labelResult.data);
              } else if (labelResult.data === null) {
                labelValue = 'null';
              } else if (Array.isArray(labelResult.data)) {
                // For arrays, show compact representation
                if (labelResult.data.length === 0) {
                  labelValue = '[]';
                } else if (labelResult.data.length === 1) {
                  // Single item - extract it
                  const singleItem = labelResult.data[0];
                  if (typeof singleItem === 'string') {
                    labelValue = singleItem;
                  } else if (typeof singleItem === 'number' || typeof singleItem === 'boolean') {
                    labelValue = String(singleItem);
                  } else if (singleItem === null) {
                    labelValue = 'null';
                  } else if (typeof singleItem === 'object') {
                    // Single object in array - try to extract identifier
                    if (singleItem.id) {
                      labelValue = String(singleItem.id);
                    } else if (singleItem.name) {
                      labelValue = String(singleItem.name);
                    } else {
                      labelValue = JSON.stringify(singleItem);
                    }
                  } else {
                    labelValue = String(singleItem);
                  }
                } else {
                  // Multiple items
                  labelValue = `[${labelResult.data.length} items]`;
                }
              } else if (typeof labelResult.data === 'object') {
                // For objects, try to find a useful identifier
                const obj = labelResult.data;
                if (obj.id) {
                  labelValue = String(obj.id);
                } else if (obj.name) {
                  labelValue = String(obj.name);
                } else if (obj.email) {
                  labelValue = String(obj.email);
                } else if (obj.title) {
                  labelValue = String(obj.title);
                } else {
                  // Show keys as hint
                  const keys = Object.keys(obj).slice(0, 3).join(', ');
                  labelValue = `{${keys}${Object.keys(obj).length > 3 ? '...' : ''}}`;
                }
              } else {
                labelValue = String(labelResult.data);
              }
              
              // Cache the result
              labelCache[absoluteLabelPath] = labelValue;
            } else {
              // Label query didn't return a result - show "(no label)"
              labelValue = w('(no label)', 'dim');
            }
          }
          
          displayPath = labelValue;
        } catch (err) {
          // Fallback to short path on error
          displayPath = QueryExecutor.formatWildcardPath(
            QueryExecutor.pathArrayToString(item.path),
            basePath
          );
        }
      } else {
        // No label query - use short path
        displayPath = QueryExecutor.formatWildcardPath(
          QueryExecutor.pathArrayToString(item.path),
          basePath
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
      
      const lineNumber = w(`[${displayedCount + 1}]`, 'dim');
      allLines.push(`${lineNumber} ${w(displayPath, 'path')} → ${valuePreview}`);
      displayedLabels.push({ label: displayPath, value: valuePreview });
      displayedCount++;
    }
    
    // Store displayed labels for copy-results
    this.tui.lastDisplayedLabels = displayedLabels;
    
    // Build complete content string
    let fullContent = this.tui.resultsBox.getContent(); // Start with header
    fullContent += allLines.join('\n');
    
    // Add scrolling tip at the bottom
    if (results.length > 10) {
      fullContent += '\n\n' + w(`Showing all ${displayedCount} results - use mouse wheel or ↑/↓ to scroll`, 'dim');
    }
    
    // Add tips at bottom
    if (displayedCount > 1) {
      fullContent += '\n' + w('Tip: Type number to view item in detail', 'dim');
    }
    
    // Set the complete content
    this.tui.resultsBox.setContent(fullContent);
    this.tui.resultsBox.setScrollPerc(0);
    this.tui.screen.render();
  }

  /**
   * Display a single result
   */
  displayResult(data, path, skipPrompt = false) {
    this.tui.lastDisplayedType = 'result';
    this.tui.lastWildcardResults = null;
    this.tui.searchMatches = []; // Clear search matches when showing a single result
    
    const w = this.wrapColor.bind(this);
    
    // Check if result looks like a URI-encoded or JSON string
    let shouldPrompt = false;
    if (!skipPrompt && typeof data === 'string' && data.length > 0) {
      // Check for URI encoding
      const hasURIEncoding = /%[0-9A-F]{2}/i.test(data);
      
      // Check for JSON string
      const looksLikeJSON = (data.startsWith('{') || data.startsWith('[')) && 
                           (data.endsWith('}') || data.endsWith(']'));
      
      if (hasURIEncoding || looksLikeJSON) {
        shouldPrompt = true;
      }
    }
    
    if (shouldPrompt) {
      // Show the prompt in the info box
      this.tui.infoBox.setContent(
        w('This looks like encoded/stringified content. Decode? (y/n)', 'warning')
      );
      this.tui.screen.render();
      this.tui.waitingForPrompt = true;
      this.tui.promptType = typeof data === 'string' && /%[0-9A-F]{2}/i.test(data) ? 'decode' : 'parse';
    }
    
    // Format and display
    const formatted = Formatter.prettyPrint(data);
    this.appState.setLastResult(data, path);
    
    // Set header
    const headerInfo = `✓ Result from: ${w(path, 'path')}`;
    this.tui.resultsBox.setContent(
      headerInfo + '\n' +
      w('─'.repeat(50), 'dim') + '\n\n' +
      formatted + '\n\n' +
      w('─'.repeat(50), 'dim') + '\n' +
      w('Tip: :copy to clipboard, :decode/:parse if needed', 'dim')
    );
    
    this.tui.resultsBox.setScrollPerc(0);
    this.tui.screen.render();
  }
}

module.exports = { DisplayManager, TUI_COLORS };

