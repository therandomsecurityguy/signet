FROM node:22-bookworm-slim

WORKDIR /workspace/service/mcp

ENV NODE_ENV=development
ENV npm_config_update_notifier=false
ENV npm_config_fund=false

# Keep image warm; source code is bind-mounted in docker-compose.
COPY service/mcp/package*.json ./
RUN npm ci

CMD ["npm", "run", "dev"]
