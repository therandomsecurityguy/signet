import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { buildTransparencySampleGraphSpec, readTransparencySampleGraphSpec } from '../src/transparency/sample-graph.js';

describe('transparency sample graph fixtures', () => {
  it('loads the committed transparency sample spec', async () => {
    const specPath = fileURLToPath(new URL('../examples/transparency/sample-graph.spec.json', import.meta.url));
    const spec = await readTransparencySampleGraphSpec(specPath);

    expect(spec).toEqual(buildTransparencySampleGraphSpec());
  });
});
