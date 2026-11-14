FROM node:22-bookworm-slim

WORKDIR /workspace/service/tessera-sidecar

ENV NODE_ENV=development
ENV npm_config_update_notifier=false
ENV npm_config_fund=false

COPY service/tessera-sidecar/package*.json ./
RUN npm ci

CMD ["npm", "run", "dev"]
