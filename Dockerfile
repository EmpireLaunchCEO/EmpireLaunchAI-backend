# Single-stage Dockerfile for Railway - explicitly bypasses nixpacks auto-detection
# Dynamic cache bust: RAILWAY_GIT_COMMIT_SHA changes on every git push, busting Docker layer cache
ARG CACHE_BREAKER=${RAILWAY_GIT_COMMIT_SHA:-v1-docker-revival-v2}
FROM node:20-slim
RUN apt-get update && apt-get install -y \
    libvips42 ffmpeg python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=${PORT:-3000}
EXPOSE ${PORT:-3000}
CMD ["npm", "start"]