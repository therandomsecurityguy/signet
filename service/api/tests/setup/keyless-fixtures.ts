import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

// Keyless-signature fixtures are generated at test time from
// scripts/generate-keyless-test-fixtures.sh (openssl): the private keys are
// throwaway test material and must never be committed — committed private
// keys are treated as leaked secrets by the security scanners and get
// redacted on the branch, breaking the suite.
export default function setup(): void {
  const fixturesDir = path.resolve('tests/fixtures/keyless');
  execFileSync('bash', [path.resolve('../../scripts/generate-keyless-test-fixtures.sh'), fixturesDir], {
    stdio: 'inherit',
  });
}
