# Single-stage Dockerfile for Railway - explicitly bypasses nixpacks auto-detection
ARG CACHE_BREAKER=v1-docker-revival
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