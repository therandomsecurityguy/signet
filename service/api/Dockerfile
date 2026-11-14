# syntax=docker/dockerfile:1
# Production image for the Signet management-plane API (service/api).
# Build context is the repo root (per the platform release pipeline).

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build

WORKDIR /workspace

# Install dependencies for the API. The API imports the registry core via
# relative paths (compiled into dist), so the registry's own dependencies must
# be installed too — they are not resolvable from service/api/node_modules.
COPY service/api/package*.json service/api/
COPY service/registry/package*.json service/registry/
RUN cd service/api && npm ci
RUN cd service/registry && npm ci

# Copy source. The API imports the registry core via relative paths, so the
# registry source must be present for the build (it is compiled into dist).
COPY service/api service/api
COPY service/registry service/registry

RUN cd service/api && npm run build


FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

ENV NODE_ENV=production
WORKDIR /workspace

# Copy built output and runtime dependencies.
COPY --from=build /workspace/service/api/dist service/api/dist
COPY --from=build /workspace/service/api/node_modules service/api/node_modules
COPY --from=build /workspace/service/api/package*.json service/api/
# The compiled registry core imports its own packages (e.g. @sigstore/*,
# rdf-canonize, re2js). Node's module resolution walks up from the compiled
# files under service/api/dist/service/registry/**, so the registry's
# node_modules must ship beside them at a resolvable ancestor.
COPY --from=build /workspace/service/registry/node_modules service/node_modules

RUN groupadd -r -g 10001 signet && useradd -r -u 10001 -g signet signet && chown -R signet:signet /workspace
USER signet

WORKDIR /workspace/service/api
EXPOSE 3100

CMD ["npm", "start"]
