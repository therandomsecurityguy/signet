# syntax=docker/dockerfile:1
# Production image for the Signet knowledge-manager webapp
# (service/webapp/knowledge-manager). Build context is the repo root.

FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS build

WORKDIR /workspace

# Install dependencies for the webapp.
# sqlite3 npm prebuilds target newer glibc than bookworm (2.36) and fail
# to dlopen at runtime; compile it against this image's toolchain instead.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV npm_config_build_from_source=true

COPY service/webapp/knowledge-manager/package*.json service/webapp/knowledge-manager/
RUN cd service/webapp/knowledge-manager && npm ci

# Copy source. The webapp does not import the registry core directly.
COPY service/webapp/knowledge-manager service/webapp/knowledge-manager

RUN cd service/webapp/knowledge-manager && npm run build


FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9

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
