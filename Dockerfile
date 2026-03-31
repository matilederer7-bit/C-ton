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

EXPOSE 3000

CMD ["npm", "run", "start:demo:prod"]
