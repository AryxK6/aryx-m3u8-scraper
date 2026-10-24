# ═══════════════════════════════════════════════════════
#  ARYX M3U8 SCRAPER — Production Dockerfile
# ═══════════════════════════════════════════════════════

# Stage 1: Install dependencies
FROM mcr.microsoft.com/playwright:v1.52.0 AS builder

LABEL maintainer="ARYX"
LABEL version="2.0.0"
LABEL description="ARYX M3U8 SCRAPER — Production-grade HLS stream extractor"

WORKDIR /app

# Copy dependency manifests first (layer caching)
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: Production image
FROM mcr.microsoft.com/playwright:v1.52.0

WORKDIR /app

# Install dumb-init for proper PID 1 signal handling
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r aryx && useradd -r -g aryx -G audio,video aryx \
    && mkdir -p /home/aryx && chown -R aryx:aryx /home/aryx

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY server.js ./
COPY utils/ ./utils/
COPY package.json ./

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=4000

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/v1/health').then(r=>{if(!r.ok)throw new Error();process.exit(0)}).catch(()=>process.exit(1))"

# Switch to non-root user
USER aryx

# Use dumb-init as PID 1
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"]
