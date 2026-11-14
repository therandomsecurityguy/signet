import pino from 'pino';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  'authorization',
  'cookie',
  'set-cookie',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.password',
  '*.connection_string',
] as const;

export function buildLogger(options?: { level?: string; destination?: pino.DestinationStream }) {
  return pino(
    {
      level: options?.level ?? env.LOG_LEVEL,
      redact: {
        paths: [...LOG_REDACT_PATHS],
        censor: '[REDACTED]',
      },
      base: {
        service: env.SERVICE_NAME,
        environment: env.NODE_ENV ?? 'development',
      },
    },
    options?.destination,
  );
}

export const logger = buildLogger();
