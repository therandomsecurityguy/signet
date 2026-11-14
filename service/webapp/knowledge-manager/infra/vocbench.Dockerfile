FROM eclipse-temurin:17-jre@sha256:0b6521287f850ec1c4b31c9074c5a1ae1d67c5922c3fefd21065c7c32e244d4a

WORKDIR /workspace

ENV VOCBENCH_ROOT=/workspace
ENV VOCBENCH_RUNTIME_DIR=/workspace/tools/vocbench/runtime

COPY scripts/vocbench-start.sh /usr/local/bin/vocbench-start.sh
RUN chmod +x /usr/local/bin/vocbench-start.sh

CMD ["/usr/local/bin/vocbench-start.sh"]
