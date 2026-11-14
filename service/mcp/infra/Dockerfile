FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

WORKDIR /workspace/service/mcp

ENV NODE_ENV=development
ENV npm_config_update_notifier=false
ENV npm_config_fund=false

# Keep image warm; source code is bind-mounted in docker-compose.
COPY service/mcp/package*.json ./
RUN npm ci

CMD ["npm", "run", "dev"]
