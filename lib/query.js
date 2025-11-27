#!/usr/bin/env node

const { JSONPath } = require('jsonpath-plus');
const { PathExtractor } = require('./path');

// ============= QUERY EXECUTOR =============

/**
 * QueryExecutor - Executes JSONPath queries and formats results
 * 
 * @class
 * @description Handles JSONPath query execution, wildcard detection, and result formatting
 */
class QueryExecutor {
  /**
   * Create a query executor
   * 
   * @param {AppState} appState - Application state instance
   * @param {SearchEngine} SearchEngine - Search engine instance
   */
  constructor(appState, SearchEngine) {
    this.appState = appState;
    this.SearchEngine = SearchEngine;
  }

  /**
   * Execute a JSONPath query
   * 
   * @param {string} path - JSONPath query string
   * @returns {{success: boolean, data: *, isWildcard: boolean, basePath: string, error: string}} Query result
   */
  execute(path) {
    try {
      // Check if this is a wildcard query
      const hasWildcard = path.includes('[*]') || path.includes('.*');
      
      if (hasWildcard) {
        // For wildcard queries, get all matching paths and values
        const results = JSONPath({
          path: path,
          json: this.appState.jsonData,
          resultType: 'all'
        });
        
        if (results && results.length > 0) {
          return {
            success: true,
            data: results,
            method: 'jsonpath',
            isWildcard: true,
            basePath: path
          };
        }
        return { success: false, suggestions: this.SearchEngine.fuzzySearchPaths(path).slice(0, 5) };
      }
      
      // Regular query
      let result = JSONPath({
        path: path,
        json: this.appState.jsonData,
        wrap: false
      });
      
      if (result === undefined || result === null || (Array.isArray(result) && result.length === 0)) {
        // Try manual traversal
        const manualResult = PathExtractor.manualTraverse(this.appState.jsonData, path);
        if (manualResult !== undefined) {
          return { success: true, data: manualResult, method: 'manual', isWildcard: false };
        }
        return { success: false, suggestions: this.SearchEngine.fuzzySearchPaths(path).slice(0, 5) };
      }
      
      return { success: true, data: result, method: 'jsonpath', isWildcard: false };
    } catch (error) {
      // Try manual traversal as fallback
      const manualResult = PathExtractor.manualTraverse(this.appState.jsonData, path);
      if (manualResult !== undefined) {
        return { success: true, data: manualResult, method: 'manual', isWildcard: false };
      }
      
      return { success: false, error: error.message, suggestions: this.SearchEngine.fuzzySearchPaths(path).slice(0, 5) };
    }
  }
  
  static pathArrayToString(pathArray) {
    // Convert JSONPath array format to string
    // e.g., ['$', 'getHotelExpress.Results', 'hotel_data', 0, 'id'] => "$['getHotelExpress.Results'].hotel_data[0].id"
    if (!Array.isArray(pathArray)) return String(pathArray);
    
    let result = '';
    for (let i = 0; i < pathArray.length; i++) {
      const part = pathArray[i];
      
      if (i === 0 && part === '$') {
        result = '$';
      } else if (typeof part === 'number') {
        // Array index
        result += `[${part}]`;
      } else if (typeof part === 'string') {
        // Check if the key needs bracket notation (contains dots, spaces, or special chars)
        if (part.includes('.') || part.includes(' ') || part.includes('[') || part.includes(']')) {
          result += `['${part}']`;
        } else {
          // Simple property - use dot notation
          result += `.${part}`;
        }
      }
    }
    
    return result;
  }
  
  static formatWildcardPath(fullPath, basePath) {
    // Extract the relevant part after the wildcard base
    // e.g., base: "$.data.items[*]", full: "$.data.items[3].id" => "items[3].id"
    const wildcardIndex = basePath.indexOf('[*]');
    if (wildcardIndex === -1) return fullPath;
    
    // Get the base before wildcard
    const baseBeforeWildcard = basePath.substring(0, wildcardIndex);
    
    // Remove the base from the full path
    let relativePath = fullPath;
    if (fullPath.startsWith(baseBeforeWildcard)) {
      relativePath = fullPath.substring(baseBeforeWildcard.length);
      // Clean up leading dots
      relativePath = relativePath.replace(/^\./, '');
    }
    
    return relativePath || fullPath;
  }
}

module.exports = { QueryExecutor };

