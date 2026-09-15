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

# R6 — build the new canonical React frontend (web/) into web/dist, served
# same-origin under /preview by the Web service. --include=dev is required
# because NODE_ENV=production would otherwise omit Vite/TypeScript.
RUN cd web && npm ci --include=dev && npm run build && npm prune --omit=dev

# Run as non-root user.
RUN useradd -m appuser && mkdir -p /var/lib/siton/uploads/deal-images && chown -R appuser:appuser /var/lib/siton
ENV DEAL_IMAGE_UPLOAD_DIR=/var/lib/siton/uploads/deal-images
USER appuser

EXPOSE 3000

# /health is a cheap liveness probe — does not touch DB, providers or workers.
# Use /api/admin/mission-control (with x-admin-key) for full readiness in operator dashboards.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# The container entrypoint is the Node runtime ITSELF (exec form), so the
# platform's stop signal (docker stop / compose stop / Render deploy) reaches
# src/app.ts's SIGTERM handler directly and the process exits 0 after
# app.close() + pool.end(). It is the same program `npm run start:web:prod`
# runs, without npm as PID 1: npm forwards the signal to its child shell, then
# re-sends it to itself, and as PID 1 with no handler left it cannot die from
# it and exits 1 instead - the release lab measured web=1 / worker=1 on a
# normal stop. The worker is started the same way in
# docker-compose.release-lab.yml (`node .demo_dist/src/worker.js`).
CMD ["node", ".demo_dist/src/app.js"]
