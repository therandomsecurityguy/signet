import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';

import type { Env } from '../../infrastructure/config/env.js';
import type { GovernanceLogUseCase } from '../../application/usecases/governance-log.js';
import {
  EventsStreamQuerySchema,
  ListGovernanceEventsOutputSchema,
  ListGovernanceEventsQuerySchema,
} from '../../contracts/events.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import { logger } from '../../infrastructure/logging/pino.js';
import type { AppEnv } from '../server.js';

const listEventsRoute = createRoute({
  method: 'get',
  path: '/v1/events',
  request: { query: ListGovernanceEventsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListGovernanceEventsOutputSchema } },
      description: 'Governance events (newest first; ascending with after_position)',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid event query parameters' },
  },
});

// Trust event feed (build plan 2.2). Read-only: lists and streams the
// governance events already recorded by lifecycle operations, with their
// Merkle log positions. The stream is deliberately poll-backed against the
// shared log node (cross-replica safe; delivery latency = poll cadence)
// rather than an in-process bus.
export function registerEventRoutes(app: OpenAPIHono<AppEnv>, deps: { events: GovernanceLogUseCase; env: Env }) {
  app.openapi(listEventsRoute, async (c) => {
    const parsed = ListGovernanceEventsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid event query parameters.' } }, 400);
    }
    return c.json(
      await deps.events.listEvents({
        ...(parsed.data.event_type !== undefined ? { event_type: parsed.data.event_type } : {}),
        ...(parsed.data.publication_urn !== undefined ? { publication_urn: parsed.data.publication_urn } : {}),
        ...(parsed.data.logical_key !== undefined ? { logical_key: parsed.data.logical_key } : {}),
        ...(parsed.data.since !== undefined ? { since: parsed.data.since } : {}),
        ...(parsed.data.until !== undefined ? { until: parsed.data.until } : {}),
        ...(parsed.data.after_position !== undefined ? { after_position: parsed.data.after_position } : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      }),
      200,
    );
  });

  // Server-Sent Events. Not part of the OpenAPI JSON surface (frames are not
  // JSON envelopes). Filters match the list endpoint; `since_position` is an
  // exclusive cursor (-1 replays the whole log).
  app.get('/v1/events/stream', async (c) => {
    const parsed = EventsStreamQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid event stream parameters.' } }, 400);
    }
    const filters = {
      ...(parsed.data.event_type ? { event_type: parsed.data.event_type } : {}),
      ...(parsed.data.publication_urn ? { publication_urn: parsed.data.publication_urn } : {}),
      ...(parsed.data.logical_key ? { logical_key: parsed.data.logical_key } : {}),
    };
    const pollMs = deps.env.EVENTS_STREAM_POLL_MS;
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let flushing = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {
            // Already closed by the runtime.
          }
        };
        c.req.raw.signal.addEventListener('abort', close);

        let cursor: number;
        try {
          const head = await deps.events.listEvents({ limit: 1 });
          cursor = parsed.data.since_position ?? head.latest_position ?? -1;
        } catch (err) {
          logger.error({ err }, 'event stream: failed to read the governance log head');
          close();
          return;
        }

        const flush = async () => {
          if (closed || flushing) return;
          flushing = true;
          try {
            const page = await deps.events.listEvents({ ...filters, after_position: cursor, limit: 200 });
            for (const event of page.events) {
              controller.enqueue(encoder.encode(`id: ${event.position}\ndata: ${JSON.stringify(event)}\n\n`));
              cursor = event.position;
            }
            if (page.events.length === 0) {
              controller.enqueue(encoder.encode(': keep-alive\n\n'));
            }
          } catch (err) {
            logger.error({ err }, 'event stream: poll failed');
            close();
          } finally {
            flushing = false;
          }
        };

        await flush();
        if (closed) return;
        timer = setInterval(() => {
          void flush();
        }, pollMs);
      },
      cancel() {
        closed = true;
        if (timer) clearInterval(timer);
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });
}
