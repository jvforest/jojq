#!/usr/bin/env node

const fuzzysort = require('fuzzysort');
const { PathExtractor } = require('./path');
const { JSONPath } = require('jsonpath-plus');
const { QueryExecutor } = require('./query');

// ============= SEARCH ENGINE =============
class SearchEngine {
  constructor(appState, CommandHandler) {
    this.appState = appState;
    this.CommandHandler = CommandHandler;
  }

  searchInJSON(searchTerm) {
    const matches = [];
    
    const traverse = (obj, path) => {
      if (obj === null || obj === undefined) return;
      
      const valueStr = typeof obj === 'object' ? JSON.stringify(obj) : String(obj);
      if (valueStr.toLowerCase().includes(searchTerm.toLowerCase())) {
        matches.push({
          path: path,
          value: obj,
          preview: this.createPreview(obj)
        });
      }
      
      if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
          traverse(item, `${path}[${index}]`);
        });
      } else if (typeof obj === 'object') {
        Object.keys(obj).forEach(key => {
          const newPath = PathExtractor.buildPath(path, key);
          traverse(obj[key], newPath);
        });
      }
    };
    
    traverse(this.appState.jsonData, '$');
    return matches;
  }
  
  createPreview(obj) {
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'object') return JSON.stringify(obj).substring(0, 100);
    return String(obj);
  }
  
  static normalizePath(path) {
    // Convert bracket notation to dot notation for fuzzy matching
    // $['key']['nested'] -> $.key.nested
    // But preserve $['key.with.dots'] as-is for special keys
    return path
      .replace(/\[['"]([^'".\[\]]+)['"]\]/g, '.$1')  // ['simple'] -> .simple
      .replace(/\.\./g, '.');  // Fix any double dots
  }

  fuzzySearchPaths(input = '', prioritizeWildcards = false) {
    // Pagination commands for search results
    if (this.appState.lastSearchResults.length > 0 && (input === 'n' || input === 'p')) {
      return [];
    }
    
    // Numbered selection from search results
    if (this.appState.lastSearchResults.length > 0 && /^\d+$/.test(input)) {
      return [];
    }
    
    // Command search
    if (input.startsWith(':')) {
      return this.CommandHandler.getCommandSuggestions(input.substring(1));
    }
    
    // Search mode
    if (input.startsWith('/')) {
      return [];
    }
    
    // Path search - show initial suggestions
    if (!input || input.trim() === '') {
      // Show first 15 paths for better discoverability
      const paths = this.appState.allPaths.slice(0, 15);
      
      // If no paths yet, return helpful placeholder
      if (paths.length === 0) {
        return [{ path: 'Loading paths...', score: 0, preview: 'Please wait while paths are extracted' }];
      }
      
      // If prioritizing wildcards, show wildcard versions first
      if (prioritizeWildcards) {
        return this.prioritizeWildcardPaths(paths);
      }
      return paths.map(path => ({ path, score: 0 }));
    }
    
    // Check for wildcard shortcut: ending with * or w: prefix
    const hasWildcardShortcut = input.endsWith('*') || input.startsWith('w:');
    if (hasWildcardShortcut) {
      // Remove shortcut and add [*] to suggestions
      const cleanInput = input.replace(/^w:/, '').replace(/\*$/, '');
      return this.generateWildcardSuggestions(cleanInput);
    }
    
    // Normalize input for fuzzy matching (convert bracket to dot notation)
    let searchInput = SearchEngine.normalizePath(input);
    
    // Handle wildcard queries - replace [*] with [0] for fuzzy matching
    const hasWildcard = searchInput.includes('[*]');
    if (hasWildcard) {
      searchInput = searchInput.replace(/\[\*\]/g, '[0]');
    }
    
    // Combine allPaths with expanded cache for search
    const allSearchablePaths = [
      ...this.appState.allPaths,
      ...Array.from(this.expandedPathsCache || [])
    ];
    
    let results = fuzzysort.go(searchInput, allSearchablePaths, {
      limit: 15, // Get more results to prioritize wildcards
      threshold: -10000
    });
    
    // If we don't have good matches and user is typing a specific path,
    // try to expand paths on-demand from the relevant part of JSON
    if (results.length === 0 || (results.length > 0 && results[0].score < -5000)) {
      // Try to find matching paths by querying the JSON directly
      const expandedPaths = this.expandPathsOnDemand(input, searchInput);
      if (expandedPaths.length > 0) {
        // Search the expanded paths too
        const expandedResults = fuzzysort.go(searchInput, expandedPaths, {
          limit: 10,
          threshold: -10000
        });
        // Merge with existing results, prioritizing exact matches
        results.push(...expandedResults.map(r => ({ path: r.target, score: r.score - 1000 }))); // Lower score
        // Sort by score and limit
        results.sort((a, b) => (b.score || 0) - (a.score || 0));
        results.splice(15); // Keep top 15
      }
    }
    
    // If input had wildcard, replace [0] or any [N] with [*] in results
    if (hasWildcard) {
      return results.map(r => {
        // Replace the specific index with [*] in the result
        const wildcardPath = (r.path || r.target).replace(/\[(\d+)\]/g, '[*]');
        return { path: wildcardPath, score: r.score };
      });
    }
    
    // Prioritize wildcard versions if requested or if path likely contains arrays
    if (prioritizeWildcards || this.shouldPrioritizeWildcards(input, results)) {
      return this.prioritizeWildcardSuggestions(results, input);
    }
    
    return results.map(r => ({ path: r.path || r.target, score: r.score }));
  }
  
  /**
   * Check if we should prioritize wildcard suggestions
   * @param {string} input - User input
   * @param {Array} results - Current fuzzy search results
   * @returns {boolean}
   */
  shouldPrioritizeWildcards(input, results) {
    // If user typed something that looks like it could be an array path
    // (e.g., ends with a field name that might have arrays)
    const likelyArrayField = /\.([a-zA-Z_$][\w$]*)$/.test(input);
    
    // Check if any results contain array indices
    const hasArrayIndices = results.some(r => /\[\d+\]/.test(r.target));
    
    return likelyArrayField && hasArrayIndices;
  }
  
  /**
   * Generate wildcard suggestions from input
   * @param {string} input - Clean input (without wildcard shortcuts)
   * @returns {Array} Array of {path, score} objects with wildcard paths
   */
  generateWildcardSuggestions(input) {
    if (!input || input.trim() === '') {
      // Show common wildcard patterns
      return [
        { path: '$[*]', score: 0, preview: 'All root items' },
        { path: '$.data[*]', score: 0, preview: 'All items in data array' },
        { path: '$.items[*]', score: 0, preview: 'All items in items array' },
        { path: '$.results[*]', score: 0, preview: 'All items in results array' }
      ];
    }
    
    // Find matching paths and convert to wildcard versions
    const normalized = SearchEngine.normalizePath(input);
    const results = fuzzysort.go(normalized, this.appState.allPaths, {
      limit: 10,
      threshold: -10000
    });
    
    // Convert to wildcard versions
    return results.map(r => {
      const wildcardPath = r.target.replace(/\[(\d+)\]/g, '[*]');
      // Deduplicate
      return { path: wildcardPath, score: r.score };
    }).filter((item, index, self) => 
      index === self.findIndex(t => t.path === item.path)
    );
  }
  
  /**
   * Prioritize wildcard versions of paths in results
   * @param {Array} results - Fuzzy search results
   * @param {string} input - Original input
   * @returns {Array} Results with wildcard versions prioritized
   */
  prioritizeWildcardSuggestions(results, input) {
    const wildcardResults = [];
    const regularResults = [];
    const seenWildcards = new Set();
    
    // First pass: create wildcard versions and collect them
    results.forEach(r => {
      const wildcardPath = r.target.replace(/\[(\d+)\]/g, '[*]');
      
      // If this creates a wildcard version and we haven't seen it
      if (wildcardPath !== r.target && !seenWildcards.has(wildcardPath)) {
        seenWildcards.add(wildcardPath);
        wildcardResults.push({ 
          path: wildcardPath, 
          score: r.score + 1000, // Boost score for wildcards
          isWildcard: true 
        });
      }
      
      // Also keep original if it's different
      if (!wildcardPath.includes('[*]')) {
        regularResults.push({ path: r.target, score: r.score });
      }
    });
    
    // Sort wildcards by score, then regular results
    wildcardResults.sort((a, b) => b.score - a.score);
    regularResults.sort((a, b) => b.score - a.score);
    
    // Return wildcards first (up to 5), then regular results
    return [
      ...wildcardResults.slice(0, 5),
      ...regularResults.slice(0, 5)
    ];
  }
  
  /**
   * Prioritize wildcard paths in a simple path list
   * @param {Array} paths - Array of path strings
   * @returns {Array} Array of {path, score} with wildcards first
   */
  prioritizeWildcardPaths(paths) {
    const wildcards = [];
    const regular = [];
    const seen = new Set();
    
    paths.forEach(path => {
      const wildcard = path.replace(/\[(\d+)\]/g, '[*]');
      if (wildcard !== path && !seen.has(wildcard)) {
        seen.add(wildcard);
        wildcards.push({ path: wildcard, score: 1000, isWildcard: true });
      } else if (!path.includes('[*]')) {
        regular.push({ path, score: 0 });
      }
    });
    
    return [...wildcards, ...regular];
  }
  
  /**
   * Expand paths on-demand when fuzzy search doesn't find good matches
   * This helps with lazy-loaded paths - uses JSONPath to find matching paths dynamically
   * 
   * @param {string} input - Original user input
   * @param {string} searchInput - Normalized search input
   * @returns {Array} Array of path strings found dynamically
   */
  expandPathsOnDemand(input, searchInput) {
    if (!this.appState.jsonData) return [];
    
    try {
      // Extract the last part of the path (what user is likely typing)
      const lastPart = searchInput.split('.').pop() || searchInput;
      if (!lastPart || lastPart.length < 2) return []; // Need at least 2 chars
      
      // Use JSONPath to find all paths containing this key
      // This is more efficient than extracting all paths
      const searchPattern = `$..${lastPart}`;
      const matchingPaths = JSONPath({
        path: searchPattern,
        json: this.appState.jsonData,
        resultType: 'path'
      });
      
      if (matchingPaths && matchingPaths.length > 0) {
        // Convert JSONPath path arrays to strings using QueryExecutor utility
        const pathStrings = matchingPaths
          .map(pathArray => QueryExecutor.pathArrayToString(pathArray))
          .filter(path => {
            // Only include paths not already in allPaths or cache
            return !this.appState.allPaths.includes(path) && 
                   !this.expandedPathsCache.has(path);
          })
          .slice(0, 10); // Limit to 10 new paths
        
        // Add to allPaths cache for future searches (but don't persist)
        // This helps if user types similar paths
        if (pathStrings.length > 0) {
          // Add to a temporary expansion cache (not to main allPaths to keep it small)
          if (!this.expandedPathsCache) {
            this.expandedPathsCache = new Set();
          }
          pathStrings.forEach(p => this.expandedPathsCache.add(p));
        }
        
        return pathStrings;
      }
    } catch (e) {
      // If expansion fails, return empty - fuzzy search will handle it
      return [];
    }
    
    return [];
  }
}

module.exports = { SearchEngine };

