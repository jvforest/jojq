# jojq - Interactive JSON Navigator

> A powerful, interactive JSON query tool with fuzzy search, wildcards, labels, and filters - jq meets Postman in your terminal

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-UNLICENSED-green)

## Features

- **Fuzzy Path Search** - Find JSON paths by typing partial matches
- **JSONPath Queries** - Full JSONPath support with wildcard arrays
- **Contextual Labels** - Add human-readable labels to wildcard results
- **Powerful Filters** - Filter results with conditions (AND/OR logic)
- **Real-time Suggestions** - Smart autocomplete as you type
- **Proxy Mode** - Intercept and inspect HTTP traffic, integrates well with Postman.
- **Don't want to deal with SSL Certificates?** Proxy Mode creates self-signed certs for TLS

## Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/jvforest/jojq.git
cd jojq

# Install dependencies
npm install

# Make it executable
chmod +x index.js index.tui.js

# Link globally (optional)
npm link
```

### Basic Usage

```bash
# Pipe JSON data into jojq
cat data.json | jojq

# Or from a URL
curl https://api.example.com/data | jojq

# Proxy mode (intercept HTTP traffic, optional insecure flag to ignore TLS)
jojq --proxy 8888 --insecure
```
