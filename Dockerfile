# ── Stage 1: Use the official Playwright image ────────────────────────────────
# This image is based on Ubuntu and ships with ALL browser dependencies
# pre-installed, which is required for Chromium to work on Render.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Set working directory
WORKDIR /app

# Copy package files first (for Docker layer caching)
COPY package.json package-lock.json ./

# Install Node dependencies
# ci is clean/reproducible; skip postinstall so we control browser install below
RUN npm ci --ignore-scripts

# The base image already contains the matching browser and OS dependencies.

# Copy the rest of the application source
COPY . .

# Render injects PORT at runtime; default to 3001 for local Docker runs
ENV PORT=3001

# Expose the port
EXPOSE 3001

# Start the server
CMD ["node", "index.js"]
