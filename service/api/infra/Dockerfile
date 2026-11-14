FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

WORKDIR /workspace/service/api

ENV NODE_ENV=development
ENV npm_config_update_notifier=false
ENV npm_config_fund=false

COPY service/api/package*.json ./
RUN npm ci

CMD ["npm", "run", "dev"]
