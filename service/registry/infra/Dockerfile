FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

WORKDIR /workspace/service/registry

ENV NODE_ENV=development

# Registry runtime is currently domain-first; this container provides
# a shared dev shell and future execution seam.
CMD ["sh", "-lc", "echo 'registry service container ready' && sleep infinity"]
