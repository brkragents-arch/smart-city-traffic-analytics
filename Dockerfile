# ==========================================
# SmartCity Pulse AI — Production Container
# Node.js 20 Alpine Linux Minimal Runtime
# ==========================================
FROM node:20-alpine AS base

# Install curl for container health checks
RUN apk --no-cache add curl

WORKDIR /app

# Install production dependencies first (caching layer)
COPY package*.json ./
RUN npm ci --only=production

# Copy application source code
COPY server.js ./
COPY data/ ./data/
COPY public/ ./public/
COPY agent/ ./agent/

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3080

EXPOSE 3080

# Health check to ensure Express API & SSE endpoints are live
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3080/api/bootstrap || exit 1

CMD ["node", "server.js"]
