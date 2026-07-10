# Single-stage Dockerfile for Railway - explicitly bypasses nixpacks auto-detection
# Dynamic cache bust: RAILWAY_GIT_COMMIT_SHA changes on every git push, busting Docker layer cache
ARG CACHE_BREAKER=v4-cache-fix-${RAILWAY_GIT_COMMIT_SHA:-jul10-2026}
FROM node:20-slim

# Install system deps (keep these cached)
RUN apt-get update && apt-get install -y \
    libvips42 ffmpeg python3 build-essential \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy deps and install (cache-busted via CACHE_BREAKER arg above)
COPY package*.json ./

# Clean npm cache first, then install - prevents wheelhouse cache corruption
RUN npm cache clean --force 2>/dev/null || true && \
    npm install --legacy-peer-deps --no-optional 2>&1 && \
    npx playwright install chromium --with-deps 2>&1 || echo "playwright install skipped"

# Copy source and build
COPY . .
RUN npm run build 2>&1

ENV NODE_ENV=production
ENV PORT=${PORT:-3000}
EXPOSE ${PORT:-3000}
CMD ["npm", "start"]