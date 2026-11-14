FROM node:22-bookworm-slim

WORKDIR /workspace/service/registry

ENV NODE_ENV=development

# Registry runtime is currently domain-first; this container provides
# a shared dev shell and future execution seam.
CMD ["sh", "-lc", "echo 'registry service container ready' && sleep infinity"]
