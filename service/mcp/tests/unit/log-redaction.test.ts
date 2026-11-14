import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { buildLogger } from '../../src/infrastructure/logging/pino.js';

describe('log redaction', () => {
  it('redacts authorization fields', async () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const log = buildLogger({ level: 'info', destination: dest });

    log.info({ authorization: 'Bearer super-secret-token' }, 'test');
    log.info({ req: { headers: { authorization: 'Bearer other-secret' } } }, 'test2');

    const out = chunks.join('\n');
    expect(out).not.toContain('super-secret-token');
    expect(out).not.toContain('other-secret');
    expect(out).toContain('[REDACTED]');
  });
});

