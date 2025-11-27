#!/usr/bin/env node

// ============= APPLICATION STATE =============

/**
 * AppState - Centralized application state management for jojq
 * 
 * @class
 * @description Manages JSON data, extracted paths, search results, and pagination state
 */
class AppState {
  /**
   * Create application state
   */
  constructor() {
    this.jsonData = null;
    this.allPaths = [];
    this.lastSearchResults = [];
    this.lastDisplayedResult = null;
    this.lastDisplayedPath = null;
    this.searchPage = 0; // Current page for search results
    this.searchPageSize = 20; // Items per page (can be overridden by config)
  }

  /**
   * Set the JSON data
   * 
   * @param {Object} data - JSON data to analyze
   * @returns {void}
   */
  setJsonData(data) {
    this.jsonData = data;
  }

  /**
   * Set all extracted paths from JSON
   * 
   * @param {string[]} paths - Array of JSONPath strings
   * @returns {void}
   */
  setAllPaths(paths) {
    this.allPaths = paths;
  }

  /**
   * Set search results and reset pagination
   * 
   * @param {Array} results - Search results array
   * @returns {void}
   */
  setLastSearchResults(results) {
    this.lastSearchResults = results;
    this.searchPage = 0; // Reset to first page on new search
  }

  /**
   * Set the last displayed result and path
   * 
   * @param {*} result - The result data
   * @param {string} path - The JSONPath that produced this result
   * @returns {void}
   */
  setLastResult(result, path) {
    this.lastDisplayedResult = result;
    this.lastDisplayedPath = path;
  }

  clearLastSearchResults() {
    this.lastSearchResults = [];
    this.searchPage = 0;
  }

  nextSearchPage() {
    const maxPage = Math.ceil(this.lastSearchResults.length / this.searchPageSize) - 1;
    if (this.searchPage < maxPage) {
      this.searchPage++;
      return true;
    }
    return false;
  }

  prevSearchPage() {
    if (this.searchPage > 0) {
      this.searchPage--;
      return true;
    }
    return false;
  }

  getPagedSearchResults() {
    const start = this.searchPage * this.searchPageSize;
    const end = start + this.searchPageSize;
    return this.lastSearchResults.slice(start, end);
  }

  getSearchPageInfo() {
    const totalPages = Math.ceil(this.lastSearchResults.length / this.searchPageSize);
    return {
      currentPage: this.searchPage + 1,
      totalPages: totalPages,
      showing: this.getPagedSearchResults().length,
      total: this.lastSearchResults.length
    };
  }
}

module.exports = { AppState };

