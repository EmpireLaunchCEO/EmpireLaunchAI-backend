# Single-stage Dockerfile for Railway - explicitly bypasses nixpacks auto-detection
# Dynamic cache bust: RAILWAY_GIT_COMMIT_SHA changes on every git push, busting Docker layer cache
ARG CACHE_BREAKER=${RAILWAY_GIT_COMMIT_SHA:-v1-docker-revival-v2}
FROM node:20-slim
RUN apt-get update && apt-get install -y \
    libvips42 ffmpeg python3 build-essential \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps && npx playwright install chromium --with-deps || true
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=${PORT:-3000}
EXPOSE ${PORT:-3000}
CMD ["npm", "start"]