#!/usr/bin/env node

// ============= APPLICATION CONSTANTS =============

/**
 * Application-wide constants
 * 
 * @module constants
 */
const CONSTANTS = {
  // Suggestion and autocomplete
  SUGGESTION_DEBOUNCE_MS: 150,
  MAX_SUGGESTIONS: 10,
  MAX_INITIAL_SUGGESTIONS: 10,
  
  // Search and pagination
  SEARCH_PAGE_SIZE: 20,
  MAX_SEARCH_RESULTS_DISPLAY: 1000,
  
  // Path extraction
  MAX_PATH_DEPTH_INITIAL: 2,
  MAX_PATHS_TO_EXTRACT: 10000,
  
  // Proxy server
  MAX_CAPTURED_RESPONSES: 100,
  MAX_RESPONSE_SIZE_MB: 10,
  MAX_RESPONSE_SIZE_BYTES: 10 * 1024 * 1024,
  
  // UI and rendering
  SCROLL_THROTTLE_MS: 100,
  NAVIGATION_THROTTLE_MS: 50,
  WILDCARD_BATCH_SIZE: 50,
  
  // History
  DEFAULT_HISTORY_SIZE: 50,
  MAX_HISTORY_SIZE: 1000,
  
  // File operations
  MAX_FILENAME_LENGTH: 255,
  DEFAULT_SAVE_PREFIX: 'jojq-result',
  
  // Performance
  LARGE_JSON_THRESHOLD_MB: 5,
  LARGE_JSON_THRESHOLD_BYTES: 5 * 1024 * 1024,
  VERY_LARGE_JSON_THRESHOLD_MB: 25,
  VERY_LARGE_JSON_THRESHOLD_BYTES: 25 * 1024 * 1024,
  
  // Path extraction limits
  MAX_PATHS_EXTRACT: 50000,
  MAX_ARRAY_ITEMS_INDEX: 10,
  MAX_EXTRACTION_TIME_MS: 5000,
  LAZY_EXTRACTION_DEPTH: 2
};

module.exports = { CONSTANTS };

