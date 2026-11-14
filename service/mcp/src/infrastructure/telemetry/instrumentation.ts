import { diag, DiagConsoleLogger, DiagLogLevel, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { loadEnv } from '../config/env.js';

const env = loadEnv();

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

function buildSpanProcessor(): SpanProcessor {
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const url = env.OTEL_EXPORTER_OTLP_ENDPOINT.endsWith('/v1/traces')
      ? env.OTEL_EXPORTER_OTLP_ENDPOINT
      : `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`;
    return new BatchSpanProcessor(new OTLPTraceExporter({ url }));
  }
  // Dev fallback: log spans to stdout.
  return new SimpleSpanProcessor(new ConsoleSpanExporter());
}

const provider = new NodeTracerProvider({
  spanProcessors: [buildSpanProcessor()],
});
provider.register();

trace.getTracer(env.SERVICE_NAME).startSpan('service.startup').end();

process.on('SIGINT', () => {
  void provider.shutdown();
});
process.on('SIGTERM', () => {
  void provider.shutdown();
});
