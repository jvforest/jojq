#!/usr/bin/env node

const fuzzysort = require('fuzzysort');
const { getColor } = require('./config');

// ============= TEXT UTILITIES =============
class TextUtils {
  static isURIEncoded(str) {
    // Check if string contains URI encoding patterns (%XX where XX is hex)
    return typeof str === 'string' && /%[0-9A-Fa-f]{2}/.test(str);
  }
  
  static isJSONString(str) {
    // Check if string looks like JSON (starts with { or [)
    if (typeof str !== 'string' || str.length < 2) return false;
    const trimmed = str.trim();
    
    // Must start with { or [
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    
    // Try to parse it to confirm it's valid JSON
    try {
      JSON.parse(trimmed);
      return true;
    } catch (e) {
      return false;
    }
  }
  
  static decodeURI(str) {
    try {
      return decodeURIComponent(str);
    } catch (e) {
      return str; // Return original if decode fails
    }
  }
  
  static parseJSONString(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return str; // Return original if parse fails
    }
  }
  
  static decodeURIData(data) {
    if (typeof data === 'string') {
      return this.decodeURI(data);
    }
    
    if (Array.isArray(data)) {
      return data.map(item => this.decodeURIData(item));
    }
    
    if (typeof data === 'object' && data !== null) {
      const decoded = {};
      for (const key in data) {
        decoded[key] = this.decodeURIData(data[key]);
      }
      return decoded;
    }
    
    return data;
  }
  
  static parseJSONData(data) {
    if (typeof data === 'string' && this.isJSONString(data)) {
      return this.parseJSONString(data);
    }
    
    if (Array.isArray(data)) {
      return data.map(item => this.parseJSONData(item));
    }
    
    if (typeof data === 'object' && data !== null) {
      const parsed = {};
      for (const key in data) {
        parsed[key] = this.parseJSONData(data[key]);
      }
      return parsed;
    }
    
    return data;
  }
}

// ============= FORMATTER =============
class Formatter {
  static prettyPrint(data) {
    const json = JSON.stringify(data, null, 2);
    
    return json
      .replace(/"([^"]+)":/g, getColor('jsonKey')('"$1"') + ':')
      .replace(/: "([^"]*)"/g, ': ' + getColor('jsonString')('"$1"'))
      .replace(/: (\d+\.?\d*)/g, ': ' + getColor('jsonNumber')('$1'))
      .replace(/: (true|false)/g, ': ' + getColor('jsonBoolean')('$1'))
      .replace(/: null/g, ': ' + getColor('jsonNull')('null'));
  }
  
  static checkForEncodedContent(data) {
    // Check if data contains URI-encoded strings or JSON strings
    if (typeof data === 'string') {
      if (TextUtils.isURIEncoded(data)) {
        return 'uri';
      }
      if (TextUtils.isJSONString(data)) {
        return 'json';
      }
    }
    
    if (typeof data === 'object' && data !== null) {
      // Check nested values
      for (const key in data) {
        if (typeof data[key] === 'string') {
          if (TextUtils.isURIEncoded(data[key])) {
            return 'uri';
          }
          if (TextUtils.isJSONString(data[key])) {
            return 'json';
          }
        }
      }
    }
    
    return false;
  }
  
  static highlightMatch(str, query) {
    if (!query) return str;
    
    const result = fuzzysort.single(query, str);
    if (!result) return str;
    
    let highlighted = '';
    let lastIndex = 0;
    
    if (result.indexes) {
      result.indexes.forEach(index => {
        highlighted += getColor('info')(str.slice(lastIndex, index));
        highlighted += getColor('highlight').bold(str[index]);
        lastIndex = index + 1;
      });
      highlighted += getColor('info')(str.slice(lastIndex));
    } else {
      highlighted = getColor('info')(str);
    }
    
    return highlighted;
  }
  
  static formatValue(value, maxLength = 50) {
    if (value === null) return getColor('jsonNull')('null');
    if (value === undefined) return getColor('jsonNull')('undefined');
    
    if (typeof value === 'string') {
      const truncated = value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
      return getColor('jsonString')(JSON.stringify(truncated));
    }
    
    if (typeof value === 'number') {
      return getColor('jsonNumber')(value);
    }
    
    if (typeof value === 'boolean') {
      return getColor('jsonBoolean')(value);
    }
    
    if (Array.isArray(value)) {
      return getColor('info')(`[${value.length} items]`);
    }
    
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      const preview = keys.slice(0, 3).map(k => `${k}: ${JSON.stringify(value[k])}`).join(', ');
      const extra = keys.length > 3 ? `, ... ${keys.length - 3} more` : '';
      return getColor('info')(`{${preview}${extra}}`);
    }
    
    return String(value);
  }
}

module.exports = { Formatter, TextUtils };

