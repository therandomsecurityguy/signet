# syntax=docker/dockerfile:1
# Production image for the Signet transparency sidecar (service/tessera-sidecar).
# Build context is the repo root (per the platform release pipeline).

FROM node:26-bookworm-slim AS build

WORKDIR /workspace

# Install dependencies for the sidecar.
COPY service/tessera-sidecar/package*.json service/tessera-sidecar/
RUN cd service/tessera-sidecar && npm ci

# Copy source. The sidecar does not import the registry core directly.
COPY service/tessera-sidecar service/tessera-sidecar

RUN cd service/tessera-sidecar && npm run build


FROM node:26-bookworm-slim

ENV NODE_ENV=production
WORKDIR /workspace

# Copy built output and runtime dependencies.
COPY --from=build /workspace/service/tessera-sidecar/dist service/tessera-sidecar/dist
COPY --from=build /workspace/service/tessera-sidecar/node_modules service/tessera-sidecar/node_modules
COPY --from=build /workspace/service/tessera-sidecar/package*.json service/tessera-sidecar/

RUN groupadd -r signet && useradd -r -g signet signet && chown -R signet:signet /workspace
USER signet

WORKDIR /workspace/service/tessera-sidecar
EXPOSE 3400

CMD ["npm", "start"]
