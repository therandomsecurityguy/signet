import type { Hono } from 'hono';

import { ErrorCode } from '../../domain/errors/error-codes.js';
import { DomainError } from '../../domain/errors/domain-error.js';
import type { ExecuteToolUseCase } from '../../application/usecases/execute-tool.js';
import type { ListToolsUseCase } from '../../application/usecases/list-tools.js';
import type { AppEnv } from '../server.js';

export function registerToolRoutes(
  app: Hono<AppEnv>,
  deps: {
    listTools: ListToolsUseCase;
    executeTool: ExecuteToolUseCase;
  },
) {
  app.get('/v1/tools', async (c) => {
    const body = await deps.listTools.execute();
    return c.json(body, 200);
  });

  app.post('/v1/tools/:toolCall', async (c) => {
    const toolCall = c.req.param('toolCall');
    if (!toolCall.endsWith(':execute')) {
      return c.json(
        { error: { code: ErrorCode.ToolNotFound, message: 'Tool not found.' } },
        404,
      );
    }

    const tool_name = toolCall.slice(0, -':execute'.length);
    const raw_input = await c.req.json().catch(() => undefined);

    try {
      const res = await deps.executeTool.execute({
        tool_name,
        principal: c.get('principal')!,
        raw_input,
        ctx: {
          request_id: c.get('requestId'),
          client_name: c.req.header('X-Agent-Client') ?? 'unknown',
        },
      });

      return c.json(res, 200);
    } catch (err) {
      const logger = c.get('logger');
      if (err instanceof DomainError) {
        c.status(err.httpStatus as 400 | 401 | 403 | 404 | 500);
        return c.json(
          {
            audit_id: null,
            decision: {
              effect: 'deny',
              reason: err.code,
              limits_applied: {
                max_rows: 50,
                timeout_ms: 15_000,
                max_output_bytes: 65_536,
              },
            },
            result: null,
            error: { code: err.code, message: err.safeMessage },
          },
        );
      }

      logger.error({ err }, 'unhandled error');
      c.status(500);
      return c.json(
        {
          audit_id: null,
          decision: {
            effect: 'deny',
            reason: 'internal_error',
            limits_applied: {
              max_rows: 50,
              timeout_ms: 15_000,
              max_output_bytes: 65_536,
            },
          },
          result: null,
          error: {
            code: ErrorCode.InternalError,
            message: 'Internal error.',
          },
        },
      );
    }
  });
}

