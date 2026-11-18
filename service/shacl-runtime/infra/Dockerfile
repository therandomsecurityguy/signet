# SHACL-AF runtime sidecar: Python + pyshacl. Base digest pinned; the build
# installs hash-pinned requirements only and runs as a non-root user.
FROM python:3.15-slim-bookworm@sha256:96599df822d0e1c6bb700014a05c7f3c8cabc6e0f7ff3c4f9f69cee033b4b5d9

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
