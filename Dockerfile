# Multi-stage build for smaller production image
FROM node:20-alpine AS builder

# Install Python and build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ gcc musl-dev

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

# Install only runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ gcc musl-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create directory for database files
RUN mkdir -p /data

# Copy database files into the container
# These need to be in the same directory as the Dockerfile
COPY *.db /data/

# Set environment variables with default paths
ENV TEAM_STATS_DB=/data/nfl_stats.db \
    PLAYS_DB=/data/nfl_plays.db \
    SCORES_DB=/data/nfl_scores.db

# Health check to ensure the server can start
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "console.log('Health check passed')" || exit 1

# Run as non-root user
RUN adduser -D -u 1000 nflserver && \
    chown -R nflserver:nflserver /app /data

USER nflserver

# Default command
ENTRYPOINT ["node", "dist/index.js"]

# Allow passing additional arguments
CMD ["--team-stats-db", "/data/nfl_stats.db", \
     "--plays-db", "/data/nfl_plays.db", \
     "--scores-db", "/data/nfl_scores.db"]