FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies (lockfile-pinned, reproducible).
COPY package*.json ./
RUN npm ci

# Copy source. .dockerignore excludes .env, uploads/, .tmp_*, .git, archives, docs, etc.
COPY . .

# Defense-in-depth: ensure no real .env file survived into the image, even if
# .dockerignore is misconfigured by a future change. The .env.demo.example
# template (no secrets) is intentionally allowed.
RUN find /app -maxdepth 3 -type f \( -name ".env" -o -name ".env.local" -o -name ".env.production" -o -name ".env.real" \) -delete || true

# Default deployment mode is demo-preview. Override at runtime with
# `-e APP_DEPLOYMENT_MODE=production` once a real deployment is approved.
ENV APP_DEPLOYMENT_MODE=demo-preview
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

RUN npm run build:demo

# Run as non-root user.
RUN useradd -m appuser
USER appuser

EXPOSE 3000

# /health is a cheap liveness probe — does not touch DB, providers or workers.
# Use /api/admin/mission-control (with x-admin-key) for full readiness in operator dashboards.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "run", "start:demo:prod"]
