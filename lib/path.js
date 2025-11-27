#!/usr/bin/env node

// ============= PATH EXTRACTOR =============

/**
 * PathExtractor - Extracts all JSONPath expressions from a JSON object
 * 
 * @class
 * @description Recursively traverses JSON data to extract all valid JSONPath expressions
 */
class PathExtractor {
  /**
   * Extract all paths from a JSON object
   * 
   * @static
   * @param {Object} obj - JSON object to extract paths from
   * @param {string} [prefix='$'] - Root path prefix
   * @param {Object} [options] - Extraction options
   * @param {number} [options.maxDepth] - Maximum depth to traverse (undefined = unlimited)
   * @param {number} [options.maxPaths] - Maximum number of paths to extract (undefined = unlimited)
   * @param {number} [options.maxArrayItems] - Maximum array items to index per array (default: 10)
   * @returns {string[]} Array of JSONPath strings (sorted, deduplicated)
   */
  static extractPaths(obj, prefix = '$', options = {}) {
    const { maxDepth, maxPaths, maxArrayItems = 10 } = options;
    const paths = [];
    let pathCount = 0;
    const startTime = Date.now();
    const maxExtractionTime = 5000; // 5 seconds max for initial extraction
    
    function traverse(current, path, depth = 0) {
      // Check time limit for large files
      if (Date.now() - startTime > maxExtractionTime && depth > 2) {
        return; // Stop if taking too long and we're deep
      }
      
      // Check depth limit
      if (maxDepth !== undefined && depth >= maxDepth) {
        paths.push(path);
        return;
      }
      
      // Check path count limit
      if (maxPaths !== undefined && pathCount >= maxPaths) {
        return;
      }
      
      if (current === null || current === undefined) {
        paths.push(path);
        pathCount++;
        return;
      }
      
      if (Array.isArray(current)) {
        paths.push(path);
        pathCount++;
        
        // For large arrays, only index first few items + wildcard
        if (current.length > maxArrayItems) {
          // Index first few items
          for (let i = 0; i < Math.min(maxArrayItems, current.length); i++) {
            traverse(current[i], `${path}[${i}]`, depth + 1);
          }
          // Add wildcard path
          paths.push(`${path}[*]`);
          pathCount++;
        } else {
          // Small array, index all items
          current.forEach((item, index) => {
            traverse(item, `${path}[${index}]`, depth + 1);
          });
        }
      } else if (typeof current === 'object') {
        paths.push(path);
        pathCount++;
        Object.keys(current).forEach(key => {
          const newPath = PathExtractor.buildPath(path, key);
          traverse(current[key], newPath, depth + 1);
        });
      } else {
        paths.push(path);
        pathCount++;
      }
    }
    
    traverse(obj, prefix, 0);
    return [...new Set(paths)].sort();
  }
  
  /**
   * Extract paths lazily - optimized for initial suggestions
   * For large JSON files, this provides faster startup while ensuring
   * enough paths for useful suggestions
   * 
   * @static
   * @param {Object} obj - JSON object to extract paths from
   * @param {number} [maxDepth=3] - Maximum depth to extract initially
   * @param {number} [minPaths=200] - Minimum paths to extract for suggestions
   * @returns {string[]} Array of JSONPath strings
   */
  static extractPathsLazy(obj, maxDepth = 3, minPaths = 200) {
    // Extract with depth 3 to get enough paths for suggestions
    // But limit array items to keep it fast
    let paths = this.extractPaths(obj, '$', { 
      maxDepth, 
      maxArrayItems: 5,
      maxPaths: 5000 // Limit to 5k paths for speed
    });
    
    // If we don't have enough paths, try one more level (but with stricter limits)
    if (paths.length < minPaths && maxDepth < 4) {
      const additionalPaths = this.extractPaths(obj, '$', {
        maxDepth: maxDepth + 1,
        maxArrayItems: 3, // Even fewer array items
        maxPaths: minPaths - paths.length // Only get what we need
      });
      // Merge and deduplicate
      paths = [...new Set([...paths, ...additionalPaths])].sort();
    }
    
    return paths;
  }
  
  /**
   * Estimate JSON size and determine extraction strategy
   * 
   * @static
   * @param {*} obj - JSON object
   * @returns {{sizeMB: number, isLarge: boolean, strategy: string}}
   */
  static estimateSize(obj) {
    const jsonString = JSON.stringify(obj);
    const sizeBytes = Buffer.byteLength(jsonString, 'utf8');
    const sizeMB = sizeBytes / (1024 * 1024);
    
    return {
      sizeBytes,
      sizeMB,
      isLarge: sizeMB > 5, // 5MB threshold
      isVeryLarge: sizeMB > 25, // 25MB threshold
      strategy: sizeMB > 25 ? 'lazy' : sizeMB > 5 ? 'limited' : 'full'
    };
  }
  
  static buildPath(basePath, key) {
    const needsBrackets = /[.\s\-\[\]]/.test(key) || /^\d/.test(key);
    if (needsBrackets) {
      return `${basePath}['${key}']`;
    }
    return basePath === '$' ? `$.${key}` : `${basePath}.${key}`;
  }
  
  static manualTraverse(obj, path) {
    const parts = path.replace(/^\$\.?/, '').split('.');
    let value = obj;
    for (const part of parts) {
      if (part && value && typeof value === 'object') {
        value = value[part];
      } else {
        return undefined;
      }
    }
    return value;
  }
}

module.exports = { PathExtractor };

