import { buildAppDependencies } from './src/app/dependencies.js';
import { buildApp } from './src/app/server.js';
import { loadEnv } from './src/infrastructure/config/env.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: ':memory:', REGISTRY_GRAPH_BACKEND: 'memory' });
const deps = buildAppDependencies(env);
await deps.ready();
const { token } = await deps.apiKeys.create({ owner_label: 'dbg' });
const app = buildApp(deps);
const H = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };

const create = await app.request('/v1/agents', {
  method: 'POST', headers: H,
  body: JSON.stringify({ agent_key: 'agent:dbg', source_path: 'agents/dbg.md', artifact: { content: '# x', original_path: 'agents/dbg.md' } }),
});
console.log('create', create.status);
for (const action of ['validate', 'publish']) {
  const r = await app.request(`/v1/agents/agent:dbg/versions/1/${action}`, { method: 'POST', headers: H, body: JSON.stringify({ author: 'p' }) });
  console.log(action, r.status, (await r.text()).slice(0, 120));
}
const v = await app.request('/v1/agents/agent:dbg/versions/1');
const body = (await v.json()) as { governance_artifacts: Array<{ role: string; sha256?: string; artifact_urn: string }> };
console.log('refs', JSON.stringify(body.governance_artifacts, null, 1));
for (const ref of body.governance_artifacts.filter((a) => a.role === 'validation_report')) {
  if (!ref.sha256) continue;
  const r = await app.request(`/v1/artifacts/${ref.sha256}`);
  const text = await r.text();
  console.log('artifact', ref.sha256.slice(0, 8), r.status, r.headers.get('content-type'), JSON.stringify(text.slice(0, 60)));
  try { JSON.parse(text); console.log('  parse ok'); } catch (e) { console.log('  parse FAIL:', (e as Error).message); }
}
