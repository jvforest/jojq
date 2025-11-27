#!/bin/bash

echo "🔧 Setting up jojq..."

# Install dependencies
npm install

# Make executable
chmod +x index.js index.tui.js

# Link globally
echo ""
echo "To use 'jojq' globally, run:"
echo "  npm link"
echo ""
echo "Or use directly with: cat file.json | node index.js"
echo ""
echo "✅ Setup complete!"
echo ""
echo "Try it out:"
echo "  cat example.json | node index.js"

