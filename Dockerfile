# Minimal single-stage Dockerfile to avoid multi-stage cache corruption on Railway
ARG CACHE_BREAKER=v24-single-stage

FROM node:20-bullseye-slim
RUN apt-get update && apt-get install -y libvips42 ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
