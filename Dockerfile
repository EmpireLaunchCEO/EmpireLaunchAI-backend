FROM node:20-bullseye AS builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libvips-dev \
    libfftw3-dev \
    build-essential \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Use --legacy-peer-deps to avoid the recursive dependency issues we saw on Vercel
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

FROM node:20-bullseye-slim

# Runtime dependencies
RUN apt-get update && apt-get install -y \
    libvips42 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle-pg ./drizzle-pg
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/drizzle-pg.config.ts ./drizzle-pg.config.ts

# Ensure production environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
