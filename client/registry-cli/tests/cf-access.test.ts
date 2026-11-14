import { describe, expect, it } from 'vitest';

import { cfAccessHeaders } from '../src/config/env.js';

describe('cfAccessHeaders', () => {
  it('returns the Cloudflare Access headers when both are set', () => {
    const headers = cfAccessHeaders({
      CACHET_CF_ACCESS_CLIENT_ID: 'cf-id',
      CACHET_CF_ACCESS_CLIENT_SECRET: 'cf-secret',
    } as never);
    expect(headers).toEqual({
      'CF-Access-Client-Id': 'cf-id',
      'CF-Access-Client-Secret': 'cf-secret',
    });
  });

  it('returns {} when either value is missing', () => {
    expect(cfAccessHeaders({ CACHET_CF_ACCESS_CLIENT_ID: 'cf-id' } as never)).toEqual({});
    expect(cfAccessHeaders({ CACHET_CF_ACCESS_CLIENT_SECRET: 'cf-secret' } as never)).toEqual({});
    expect(cfAccessHeaders({} as never)).toEqual({});
  });
});
