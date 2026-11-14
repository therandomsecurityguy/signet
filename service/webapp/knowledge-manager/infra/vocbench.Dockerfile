FROM eclipse-temurin:17-jre

WORKDIR /workspace

ENV VOCBENCH_ROOT=/workspace
ENV VOCBENCH_RUNTIME_DIR=/workspace/tools/vocbench/runtime

COPY scripts/vocbench-start.sh /usr/local/bin/vocbench-start.sh
RUN chmod +x /usr/local/bin/vocbench-start.sh

CMD ["/usr/local/bin/vocbench-start.sh"]
