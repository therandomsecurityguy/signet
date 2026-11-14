import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

// Keyless-signature fixtures are shared with service/api and generated at
// test time (test-only keys are never committed): the same openssl script
// writes an equivalent chain into this package's ignored fixtures directory.
export default function setup(): void {
  const fixturesDir = path.resolve('tests/fixtures/keyless');
  execFileSync('bash', [path.resolve('../../scripts/generate-keyless-test-fixtures.sh'), fixturesDir], {
    stdio: 'inherit',
  });
}
