# SHACL-AF runtime sidecar: Python + pyshacl. Base digest pinned; the build
# installs hash-pinned requirements only and runs as a non-root user.
FROM python:3.15-slim-bookworm@sha256:498829c717b1e59fc42f0e7865eafe4e04ca0f70a3769d4ae70ba218df54507c

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY service/shacl-runtime/requirements.txt ./requirements.txt
RUN pip install --require-hashes -r requirements.txt
COPY service/shacl-runtime/server.py ./server.py
RUN useradd --create-home --uid 10001 signet && chown -R signet /app
USER signet

EXPOSE 3300
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3300/healthz', timeout=3).status==200 else 1)"]

CMD ["python", "server.py"]
