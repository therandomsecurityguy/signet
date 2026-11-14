FROM node:22-bookworm-slim

WORKDIR /workspace/service/webapp/knowledge-manager

ENV NODE_ENV=development
ENV npm_config_update_notifier=false
ENV npm_config_fund=false

COPY service/webapp/knowledge-manager/package*.json ./
RUN npm ci

CMD ["npm", "run", "dev"]
