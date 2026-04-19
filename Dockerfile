FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV APP_DEPLOYMENT_MODE=demo-preview
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

RUN npm run build:demo

# Run as non-root user
RUN useradd -m appuser
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "run", "start:demo:prod"]
