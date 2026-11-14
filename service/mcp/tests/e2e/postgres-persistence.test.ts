import { describe, expect, it } from 'vitest';

import { SqliteApiKeyStore } from '../../src/infrastructure/auth/sqlite-api-key-store.js';
import { SqliteAuditPublisher } from '../../src/infrastructure/audit/sqlite-audit-publisher.js';
import { createDbProvider } from '../../src/infrastructure/persistence/db-provider.js';

const enabled = process.env['ENABLE_POSTGRES_E2E'] === '1';
const url = process.env['TEST_POSTGRES_URL'] ?? '';
const maybeIt = enabled && url.startsWith('postgres') ? it : it.skip;

describe('postgres persistence', () => {
  maybeIt('api keys and audit events survive a provider restart', async () => {
    const runId = `${Date.now()}`;

    const first = createDbProvider(url);
    await first.ready();
    const store = new SqliteApiKeyStore(first);
    const created = await store.create({ owner_label: `pg-e2e-mcp-${runId}` });

    const audit = new SqliteAuditPublisher(first);
    const auditId = `pg-e2e-mcp-audit-${runId}`;
    await audit.publishAuthEvent({
      audit_id: auditId,
      request_id: 'pg-e2e',
      client_name: 'vitest',
      principal_type: 'unknown',
      principal_id: 'unknown',
      auth_method: 'api_key',
      path: '/v1/tools',
      policy_effect: 'deny',
      policy_reason: 'pg e2e probe',
      error_code: 'UNAUTHENTICATED',
      occurred_at: new Date(),
    });
    await first.close();

    const second = createDbProvider(url);
    await second.ready();
    const storeAgain = new SqliteApiKeyStore(second);

    const resolved = await storeAgain.resolve(created.token);
    expect(resolved?.id).toBe(created.principal.id);

    await storeAgain.revoke({ key_id: created.principal.id });
    expect(await storeAgain.resolve(created.token)).toBeNull();

    const db = await second.getDb();
    const auditRow = await db.get<{ audit_id: string }>(
      'SELECT audit_id FROM audit_events WHERE audit_id = ?',
      auditId,
    );
    expect(auditRow?.audit_id).toBe(auditId);

    await second.close();
  });
});
