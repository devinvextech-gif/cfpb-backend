#!/bin/bash
echo "Installing Playwright browsers..."
npx playwright install --with-deps chromium
echo "Build complete!"
