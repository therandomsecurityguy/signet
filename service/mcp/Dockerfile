# syntax=docker/dockerfile:1
# Production image for the Signet AI-facing MCP gateway (service/mcp).
# Build context is the repo root (per the platform release pipeline).

FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS build

WORKDIR /workspace

# Install dependencies for the MCP gateway. The gateway imports the registry
# core via relative paths (compiled into dist), so the registry's own
# dependencies must be installed too — they are not resolvable from
# service/mcp/node_modules.
# sqlite3 npm prebuilds target newer glibc than bookworm (2.36) and fail
# to dlopen at runtime; compile it against this image's toolchain instead.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV npm_config_build_from_source=true

COPY service/mcp/package*.json service/mcp/
COPY service/registry/package*.json service/registry/
RUN cd service/mcp && npm ci
RUN cd service/registry && npm ci

# Copy source. The MCP gateway imports the registry core via relative paths, so
# the registry source must be present for the build (it is compiled into dist).
COPY service/mcp service/mcp
COPY service/registry service/registry

RUN cd service/mcp && npm run build


FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9

ENV NODE_ENV=production
WORKDIR /workspace

# Copy built output and runtime dependencies.
COPY --from=build /workspace/service/mcp/dist service/mcp/dist
COPY --from=build /workspace/service/mcp/node_modules service/mcp/node_modules
COPY --from=build /workspace/service/mcp/package*.json service/mcp/
# The compiled registry core imports its own packages (e.g. @sigstore/*,
# rdf-canonize, re2js). Node's module resolution walks up from the compiled
# files under service/mcp/dist/service/registry/**, so the registry's
# node_modules must ship beside them at a resolvable ancestor.
COPY --from=build /workspace/service/registry/node_modules service/node_modules

RUN groupadd -r -g 10001 signet && useradd -r -u 10001 -g signet signet && chown -R signet:signet /workspace
USER signet

WORKDIR /workspace/service/mcp
EXPOSE 3000

CMD ["npm", "start"]
