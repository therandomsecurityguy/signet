# syntax=docker/dockerfile:1
# Production image for the Cachet knowledge-manager webapp
# (service/webapp/knowledge-manager). Build context is the repo root.

FROM node:26-bookworm-slim AS build

WORKDIR /workspace

# Install dependencies for the webapp.
COPY service/webapp/knowledge-manager/package*.json service/webapp/knowledge-manager/
RUN cd service/webapp/knowledge-manager && npm ci

# Copy source. The webapp does not import the registry core directly.
COPY service/webapp/knowledge-manager service/webapp/knowledge-manager

RUN cd service/webapp/knowledge-manager && npm run build


FROM node:26-bookworm-slim

ENV NODE_ENV=production
WORKDIR /workspace

# Copy built output and runtime dependencies.
COPY --from=build /workspace/service/webapp/knowledge-manager/dist service/webapp/knowledge-manager/dist
COPY --from=build /workspace/service/webapp/knowledge-manager/node_modules service/webapp/knowledge-manager/node_modules
COPY --from=build /workspace/service/webapp/knowledge-manager/package*.json service/webapp/knowledge-manager/

RUN groupadd -r cachet && useradd -r -g cachet cachet && chown -R cachet:cachet /workspace
USER cachet

WORKDIR /workspace/service/webapp/knowledge-manager
EXPOSE 3200

CMD ["npm", "start"]
