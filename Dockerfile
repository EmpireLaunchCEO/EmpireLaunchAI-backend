# Single-stage Dockerfile for Railway - explicitly bypasses nixpacks auto-detection
ARG CACHE_BREAKER=v5-cache-purge-${RAILWAY_GIT_COMMIT_SHA:-jul10-2026}
FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y \
    libvips42 ffmpeg python3 build-essential \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy deps
COPY package*.json ./

# Clean ALL npm caches and install fresh — prevents wheelhouse corruption
RUN npm cache clean --force 2>/dev/null; rm -rf /root/.npm/_cacache 2>/dev/null; \
    npm install --legacy-peer-deps 2>&1

# Install Playwright browser
RUN npx playwright install chromium --with-deps 2>&1 || true

# Copy source and build
COPY . .
RUN npm run build 2>&1

ENV NODE_ENV=production
ENV PORT=${PORT:-3000}
EXPOSE ${PORT:-3000}
CMD ["npm", "start"]