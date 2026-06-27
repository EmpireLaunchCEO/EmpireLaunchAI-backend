# Cache breaker: bump this to force a fresh build (bypasses Railway's corrupted "wheelhouse" cache)
ARG CACHE_BREAKER=v23-node20-fix

FROM node:20.14-bullseye AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build
RUN npm prune --production

FROM node:20.14-bullseye-slim
RUN apt-get update && apt-get install -y libvips42 ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle-pg ./drizzle-pg
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
