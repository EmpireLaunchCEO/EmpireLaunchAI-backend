FROM node:20-slim AS builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Use --legacy-peer-deps to avoid the recursive dependency issues we saw on Vercel
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

FROM node:20-slim

# Install python3 in runtime image as well, just in case
RUN apt-get update && apt-get install -y \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle-pg ./drizzle-pg
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Ensure production environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
