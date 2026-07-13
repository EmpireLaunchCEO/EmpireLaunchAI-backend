# Minimal Dockerfile for Railway
ARG CACHE_BREAKER=v7-npmci-${RAILWAY_GIT_COMMIT_SHA:-jul10-2026}
FROM node:20-slim

# Use CACHE_BREAKER to invalidate Docker layer cache on each commit
LABEL cache_buster=${CACHE_BREAKER}

RUN apt-get update && apt-get install -y ffmpeg libvips42 python3 build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci 2>&1 || npm install --legacy-peer-deps 2>&1
COPY . .
RUN npm run build 2>&1

ENV NODE_ENV=production
ENV PORT=${PORT:-3000}
EXPOSE 3000
CMD ["npm", "start"]