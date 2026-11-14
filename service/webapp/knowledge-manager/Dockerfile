# syntax=docker/dockerfile:1
# Production image for the Signet knowledge-manager webapp
# (service/webapp/knowledge-manager). Build context is the repo root.

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build

WORKDIR /workspace

# Install dependencies for the webapp.
COPY service/webapp/knowledge-manager/package*.json service/webapp/knowledge-manager/
RUN cd service/webapp/knowledge-manager && npm ci

# Copy source. The webapp does not import the registry core directly.
COPY service/webapp/knowledge-manager service/webapp/knowledge-manager

RUN cd service/webapp/knowledge-manager && npm run build


FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

ENV NODE_ENV=production
WORKDIR /workspace

# Copy built output and runtime dependencies.
COPY --from=build /workspace/service/webapp/knowledge-manager/dist service/webapp/knowledge-manager/dist
COPY --from=build /workspace/service/webapp/knowledge-manager/node_modules service/webapp/knowledge-manager/node_modules
COPY --from=build /workspace/service/webapp/knowledge-manager/package*.json service/webapp/knowledge-manager/

RUN groupadd -r -g 10001 signet && useradd -r -u 10001 -g signet signet && chown -R signet:signet /workspace
USER signet

WORKDIR /workspace/service/webapp/knowledge-manager
EXPOSE 3200

CMD ["npm", "start"]
