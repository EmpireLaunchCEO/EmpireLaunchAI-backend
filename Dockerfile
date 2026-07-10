# Minimal Dockerfile for Railway
ARG CACHE_BREAKER=v6-fix-${RAILWAY_GIT_COMMIT_SHA:-jul10-2026}
FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg libvips42 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps 2>&1
COPY . .
RUN npm run build 2>&1

ENV NODE_ENV=production
ENV PORT=${PORT:-3000}
EXPOSE 3000
CMD ["npm", "start"]