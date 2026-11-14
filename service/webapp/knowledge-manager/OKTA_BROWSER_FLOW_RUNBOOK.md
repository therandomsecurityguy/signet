## Okta Browser Flow Runbook

This runbook is for exercising the real browser-based Okta login path in `service/webapp/knowledge-manager` after the durable session store is in place.

Important scope note:
- this runbook is for the registry-admin browser surface over `service/api`
- it is **not** the current development path for Semantic Turkey / VocBench ontology access
- real Okta-backed ontology access through the companion runtime remains intentionally deferred for now

### Goal
Prove that:
- the browser can complete the Okta authorization-code + PKCE flow
- `service/api` validates the resulting access token
- the durable webapp session survives a service restart
- one allowed write succeeds
- one denied write fails because of scope or claim mismatch

### Registry-operator support
The `registry-operator` CLI now supports this lane without replacing the browser login itself.

Use it to:
- validate the required API/webapp env surfaces
- check stack health before the browser proof
- optionally seed first skills and agents before the browser session proof

Helpful commands:

```bash
cd signet/client/registry-cli
npm install
npm run dev -- verify okta-config
npm run dev -- verify browser-session --manifest examples/bootstrap/bootstrap.manifest.json
npm run dev -- bootstrap test --lane okta-browser --manifest examples/bootstrap/bootstrap.manifest.json --profile minimal --api-token "<api-token>" --mcp-token "<mcp-token>"
```

### Prerequisites
- a real Okta tenant
- a web app client registered with redirect URI:
  - `http://localhost:3200/session/callback`
- an API audience configured for `service/api`
- a user/account with the intended allowed scopes/groups
- a second user/account or token shape that should be denied

### Required env for `service/api`
Set in `service/api/infra/.env`:

```bash
AUTH_MODE=okta
OKTA_MODE=real
OKTA_ISSUER=https://your-org.okta.com/oauth2/default
OKTA_AUDIENCE=api://signet
OKTA_REQUIRED_SCOPES=registry.write
OKTA_GROUPS_CLAIM=groups
```

You can also use:

```bash
AUTH_MODE=dual
OKTA_MODE=real
```

if you want API-key fallback to remain available during the same environment.

### Required env for `service/webapp/knowledge-manager`
Set in `service/webapp/knowledge-manager/infra/.env`:

```bash
DATABASE_URL=file:/workspace/data/webapp/knowledge-manager.db
AUTH_MODE=okta
OKTA_MODE=real
OKTA_ISSUER=https://your-org.okta.com/oauth2/default
OKTA_CLIENT_ID=your-webapp-client-id
OKTA_REDIRECT_URI=http://localhost:3200/session/callback
OKTA_SCOPES=openid profile email
```

You can also use:

```bash
AUTH_MODE=dual
OKTA_MODE=real
```

to mirror the API dual-mode runtime.

### Start the stack

```bash
cd signet/infra
make up
```

Verify:

```bash
curl -s http://localhost:3100/healthz
curl -s http://localhost:3200/healthz
```

### Allowed-flow proof
1. Open `http://localhost:3200`
2. Click `Sign in with Okta`
3. Complete the browser login
4. Confirm the webapp shows an authenticated management session
5. Perform one allowed write, for example:
   - register a skill, or
   - validate/publish/promote a skill version
6. Confirm the write succeeds

### Durable-session proof
1. Complete the allowed flow above
2. Restart only the webapp service

```bash
cd signet/infra
docker compose restart webapp
```

3. Reload the browser page
4. Confirm the management session is still present
5. Perform another write without re-authenticating

### Denied-flow proof
Use a user or token that should fail the configured auth policy:
- missing `registry.write` scope, or
- missing required group/claim once group-based enforcement is active

Expected result:
- session establishment may fail, or
- protected write returns a denial from `service/api`
- denial is auditable in the API service logs/audit store

### Current limits
- this runbook proves the live browser path, not the full future authz model
- fine-grained table/schema/data entitlements are still a later layer outside this webapp slice
- durable sessions persist the server-side bearer/access token locally for operator convenience; this is not a separate auth authority
