/**
 * Records the knowledge-manager demo walkthrough as a video.
 *
 * Two acts, one continuous recording:
 * 1. Terminal segment — an operator shell drives the same running demo:
 *    service status, an authored W3C SHACL Turtle policy registration, a
 *    draft rejected by it, the machine-readable validation report
 *    (`validator: shacl-v1`), and `registry-operator verify publication`.
 *    Commands run for real before recording; the captured output is typed
 *    onto a styled terminal surface (no external recorder needed).
 * 2. Browser segment — login → dashboard → skills → skill detail → graph →
 *    agents → ontology → Swagger → closing card, with a caption bar.
 *
 * Env: WEBAPP_ORIGIN (default http://localhost:3200),
 *      API_ORIGIN (default http://localhost:3100),
 *      DEMO_API_TOKEN (required for the terminal act; an agk_… key),
 *      VIDEO_DIR (default data/demo-video under the webapp package).
 *
 * Convert with:
 *   ffmpeg -y -i data/demo-video/signet-demo-raw.webm \
 *     -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart \
 *     ~/Downloads/signet-demo.mp4
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium, type Page } from 'playwright';

const WEBAPP_ORIGIN = process.env.WEBAPP_ORIGIN ?? 'http://localhost:3200';
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3100';
const VIDEO_DIR = process.env.VIDEO_DIR ?? path.resolve(process.cwd(), 'data/demo-video');
const REPO_ROOT = path.resolve(process.cwd(), '../../..');

const VIEWPORT = { width: 1280, height: 720 };

const DEMO_POLICY_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:policy:description> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [ sh:path <urn:sg:property:description> ; sh:minCount 1 ; sh:message "description_required_by_demo_shacl_policy" ] .`;

// Plain-string init script: Playwright serializes function arguments via
// fn.toString(), and tsx/esbuild rewrites nested functions with __name(...)
// helpers that do not exist in the page — a string sidesteps transpilation
// entirely.
const CAPTION_INIT_SCRIPT = `
(function () {
  function install() {
    if (!document.body || document.getElementById('demo-caption')) return;
    var style = document.createElement('style');
    style.textContent =
      '#demo-caption{position:fixed;left:24px;bottom:24px;z-index:2147483647;background:rgba(17,24,39,.94);color:#fff;font:600 21px/1.35 -apple-system,system-ui,sans-serif;padding:14px 22px;border-radius:14px;max-width:76%;box-shadow:0 10px 34px rgba(0,0,0,.4);opacity:0;transition:opacity .25s ease}' +
      '#demo-caption.on{opacity:1}' +
      '#demo-caption small{display:block;font-weight:400;font-size:14px;color:#9ca3af;margin-top:3px;letter-spacing:.01em}';
    document.head.appendChild(style);
    var el = document.createElement('div');
    el.id = 'demo-caption';
    document.body.appendChild(el);
  }
  document.addEventListener('DOMContentLoaded', install);
  install();
})();
`;

const TERMINAL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #0b1120; }
  .term {
    position: fixed; inset: 28px 48px 96px 48px; display: flex; flex-direction: column;
    background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
    font-family: "SF Mono", Menlo, Monaco, "Cascadia Code", monospace;
  }
  .term-bar {
    display: flex; align-items: center; gap: 8px; padding: 10px 14px;
    background: #111c33; border-bottom: 1px solid #1e293b;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot.r { background: #f87171; } .dot.y { background: #fbbf24; } .dot.g { background: #34d399; }
  .term-title { margin-left: 10px; color: #64748b; font-size: 13px; }
  .term-body { flex: 1; padding: 16px 18px; overflow: hidden; font-size: 14.5px; line-height: 1.55; }
  .line { white-space: pre-wrap; word-break: break-all; margin: 0 0 2px; }
  .line.cmd { color: #e2e8f0; }
  .line.cmd .prompt { color: #34d399; }
  .line.out { color: #94a3b8; }
  .line.out.ok { color: #4ade80; }
  .cursor { color: #e2e8f0; animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { to { visibility: hidden; } }
</style>
</head>
<body>
<div class="term">
  <div class="term-bar">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="term-title">signet — operator shell (local demo)</span>
  </div>
  <div id="term-body" class="term-body"></div>
</div>
<script>
${CAPTION_INIT_SCRIPT}
window.__demo = {
  typeCommand: function (cmd, lines) {
    var body = document.getElementById('term-body');
    var line = document.createElement('div');
    line.className = 'line cmd';
    var prompt = document.createElement('span');
    prompt.className = 'prompt';
    prompt.textContent = 'signet demo \\u279c ';
    var typed = document.createElement('span');
    var cursor = document.createElement('span');
    cursor.className = 'cursor';
    cursor.textContent = '\\u258c';
    line.appendChild(prompt); line.appendChild(typed); line.appendChild(cursor);
    body.appendChild(line);
    var i = 0;
    var delay = cmd.length > 120 ? 11 : 19;
    return new Promise(function (resolve) {
      function step() {
        i += 2;
        typed.textContent = cmd.slice(0, i);
        if (i < cmd.length) { setTimeout(step, delay); return; }
        cursor.remove();
        setTimeout(function () {
          (lines || []).forEach(function (text) {
            var out = document.createElement('div');
            out.className = 'line out' + (/(verified|true|shacl-v1|passed)/.test(text) ? ' ok' : '');
            out.textContent = text;
            body.appendChild(out);
          });
          setTimeout(resolve, 750);
        }, 300);
      }
      step();
    });
  }
};
</script>
</body>
</html>`;

type TerminalCommand = { typed: string; lines: string[] };

function runCapture(command: string, extraEnv: Record<string, string>): string[] {
  const output = execSync(command, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    shell: '/bin/bash',
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split('\n').filter((line) => line.trim().length > 0);
}

function captureTerminalCommands(token: string): TerminalCommand[] {
  const scratch = path.join(VIDEO_DIR, 'scratch');
  mkdirSync(scratch, { recursive: true });
  writeFileSync(
    path.join(scratch, 'demo-policy.json'),
    JSON.stringify({
      policy_version: 'demo-shacl/v1',
      author: 'demo',
      shapes_format: 'shacl-turtle',
      require_validation: true,
      shapes: DEMO_POLICY_TURTLE,
    }),
  );
  writeFileSync(
    path.join(scratch, 'demo-draft.json'),
    JSON.stringify({
      author: 'demo',
      artifact: { content: '# shacl demo', original_path: 'skills/shacl-demo.md' },
      governance: { policy_version: 'demo-shacl/v1' },
    }),
  );

  const env = {
    API: API_ORIGIN,
    AUTH: `authorization: Bearer ${token}`,
    TOK: token,
    POLICY: path.join(scratch, 'demo-policy.json'),
    DRAFT: path.join(scratch, 'demo-draft.json'),
  };
  const commands: TerminalCommand[] = [];

  commands.push({
    typed: 'scripts/demo-local.sh status',
    lines: runCapture('scripts/demo-local.sh status', env),
  });

  commands.push({
    typed: `curl -s -X POST "$API/v1/policy-packages" -H "$AUTH" -H 'content-type: application/json' -d @"$POLICY" | jq .created`,
    lines: runCapture(
      `curl -s -X POST "$API/v1/policy-packages" -H "$AUTH" -H 'content-type: application/json' -d @"$POLICY" | jq .created`,
      env,
    ),
  });

  commands.push({
    typed: `curl -s -X POST "$API/v1/skills/skill%3Ashacl-demo/drafts" -H "$AUTH" -H 'content-type: application/json' -d @"$DRAFT" >/dev/null`,
    lines: runCapture(
      `curl -s -X POST "$API/v1/skills/skill%3Ashacl-demo/drafts" -H "$AUTH" -H 'content-type: application/json' -d @"$DRAFT" >/dev/null`,
      env,
    ),
  });

  commands.push({
    typed: `curl -s -X POST "$API/v1/skills/skill%3Ashacl-demo/versions/1/validate" -H "$AUTH" -H 'content-type: application/json' -d '{"author":"demo"}' | jq -c '.result.skill_version.properties.validation_failures'`,
    lines: runCapture(
      `curl -s -X POST "$API/v1/skills/skill%3Ashacl-demo/versions/1/validate" -H "$AUTH" -H 'content-type: application/json' -d '{"author":"demo"}' | jq -c '.result.skill_version.properties.validation_failures'`,
      env,
    ),
  });

  commands.push({
    typed: `for S in $(curl -s "$API/v1/skills/skill%3Ashacl-demo/versions/1" -H "$AUTH" | jq -r '.governance_artifacts[] | select(.role=="validation_report") | .sha256'); do curl -s "$API/v1/artifacts/$S" -H "$AUTH" | jq -c 'select(.payload.validator=="shacl-v1") | {validator: .payload.validator, engine: .payload.engine, policy: .payload.layers[1].shapes_format}'; done`,
    lines: runCapture(
      `for S in $(curl -s "$API/v1/skills/skill%3Ashacl-demo/versions/1" -H "$AUTH" | jq -r '.governance_artifacts[] | select(.role=="validation_report") | .sha256'); do curl -s "$API/v1/artifacts/$S" -H "$AUTH" | jq -c 'select(.payload.validator=="shacl-v1") | {validator: .payload.validator, engine: .payload.engine, policy: .payload.layers[1].shapes_format}'; done`,
      env,
    ),
  });

  const verifyLines = runCapture(
    `cd client/registry-cli && npm run dev --silent -- verify publication --skill skill:tame-llama --version 1 --api-token "$TOK"`,
    env,
  ).filter((line) => /"(verdict|valid_signatures)"|verified|Publication/.test(line));
  commands.push({
    typed: `cd client/registry-cli && npm run dev --silent -- verify publication --skill skill:tame-llama --version 1 --api-token "$TOK"`,
    lines: verifyLines.slice(0, 6),
  });

  return commands;
}

async function caption(page: Page, title: string, subtitle?: string): Promise<void> {
  await page.evaluate(
    ({ title: t, subtitle: s }: { title: string; subtitle: string }) => {
      const el = document.getElementById('demo-caption');
      if (!el) return;
      el.innerHTML = '';
      const strong = document.createElement('span');
      strong.textContent = t;
      el.appendChild(strong);
      if (s) {
        const small = document.createElement('small');
        small.textContent = s;
        el.appendChild(small);
      }
      el.classList.add('on');
    },
    { title, subtitle: subtitle ?? '' },
  );
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

async function typeTerminalCommand(page: Page, command: TerminalCommand): Promise<void> {
  await page.evaluate(
    `window.__demo.typeCommand(${JSON.stringify(command.typed)}, ${JSON.stringify(command.lines)})`,
  );
}

async function terminalAct(page: Page, commands: TerminalCommand[]): Promise<void> {
  await page.setContent(TERMINAL_HTML, { waitUntil: 'domcontentloaded' });
  await page.evaluate(`window.__demo.typeCommand('', [])`);
  await caption(page, 'Operator view — the same registry, driven from the shell', 'Everything below runs against the local demo (no AWS, no Docker)');
  await settle(page, 2_000);

  const captions: Array<{ index: number; title: string; subtitle: string }> = [
    { index: 1, title: 'Register an authored W3C SHACL Turtle policy', subtitle: 'shapes target SKILL_VERSION; require_validation is envelope metadata' },
    { index: 3, title: 'A draft missing the required description is rejected', subtitle: 'the failing message comes from the policy shape itself' },
    { index: 4, title: 'The machine-readable report: W3C SHACL engine + policy shapes', subtitle: 'validator shacl-v1, engine identity, per-layer shapes fingerprints' },
    { index: 5, title: 'Verify before you load — the consumer contract', subtitle: 'registry-operator re-derives digests and signatures locally' },
  ];

  for (const [index, command] of commands.entries()) {
    const next = captions.find((entry) => entry.index === index);
    if (next) {
      await caption(page, next.title, next.subtitle);
      await settle(page, 600);
    }
    await typeTerminalCommand(page, command);
  }
  await settle(page, 1_500);
}

async function main(): Promise<void> {
  mkdirSync(VIDEO_DIR, { recursive: true });
  const token = process.env.DEMO_API_TOKEN;
  const terminalCommands = token ? captureTerminalCommands(token) : null;
  if (!terminalCommands) {
    console.warn('DEMO_API_TOKEN not set — recording the browser segment only.');
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    // The management-plane API serves a strict CSP; the caption overlay and
    // Swagger's CDN assets would otherwise be blocked on /v1/docs.
    bypassCSP: true,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
  });
  await context.addInitScript({ content: CAPTION_INIT_SCRIPT });
  const page = await context.newPage();

  try {
    if (terminalCommands) {
      await terminalAct(page, terminalCommands);
    }

    // 1. Title card on the login surface.
    await page.goto(new URL('/login', WEBAPP_ORIGIN).toString(), { waitUntil: 'domcontentloaded' });
    await caption(page, 'Signet — the seal of approval for agents and skills', 'Graph-first semantic governance for agents and skills · local demo');
    if (process.env.DEBUG_VIDEO) {
      console.log(
        'debug caption el:',
        await page.evaluate(() => ({
          present: Boolean(document.getElementById('demo-caption')),
          classes: document.getElementById('demo-caption')?.className,
          html: document.getElementById('demo-caption')?.innerHTML?.slice(0, 60),
        })),
      );
      await page.screenshot({ path: path.join(VIDEO_DIR, 'debug-01-title.png') });
    }
    await settle(page, 4_500);

    // 2. Sign-in: API-key mode fills the demo token; Okta modes use the
    // mock Okta button. Both establish the server-side session cookie.
    const apiToken = process.env.DEMO_API_TOKEN;
    const tokenField = page.getByLabel('API bearer token');
    if (apiToken && (await tokenField.isVisible().catch(() => false))) {
      await tokenField.fill(apiToken);
      await page.getByRole('button', { name: 'Start session' }).click();
      await settle(page, 1_500);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    } else {
      const loginButton = page.getByRole('button', { name: 'Start mock Okta session' });
      if (await loginButton.isVisible().catch(() => false)) {
        await loginButton.click();
        await settle(page, 1_500);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }
    }
    await caption(page, '1 · Sign in', 'Demo API key here; the same server-side session flow runs with Okta OIDC in production');
    await settle(page, 4_000);

    // 3. Skills catalog.
    await page.goto(new URL('/skills', WEBAPP_ORIGIN).toString(), { waitUntil: 'domcontentloaded' });
    await caption(page, '2 · Browse governed skills', 'Every version carries lifecycle state, artifacts, and validation evidence');
    await settle(page, 3_500);
    await page.mouse.wheel(0, 260);
    await settle(page, 2_500);

    // 4. Skill detail (version history, evidence).
    await page.goto(new URL(`/skills/${encodeURIComponent('skill:tame-llama')}`, WEBAPP_ORIGIN).toString(), {
      waitUntil: 'domcontentloaded',
    });
    await caption(page, '3 · Skill detail', 'Active version, artifacts, and the version history the lifecycle writes');
    await settle(page, 3_500);
    await page.mouse.wheel(0, 300);
    await settle(page, 3_000);

    // 5. The registry as a graph.
    await page.goto(new URL('/graph', WEBAPP_ORIGIN).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 10_000 }).catch(() => undefined);
    await caption(page, '4 · The registry as a graph', 'Publications, evidence, and provenance rendered as nodes and edges');
    await settle(page, 5_000);

    // 6. Agents and their linked skills.
    await page.goto(new URL('/agents', WEBAPP_ORIGIN).toString(), { waitUntil: 'domcontentloaded' });
    await caption(page, '5 · Agents', 'Agents link the skills they depend on — identity never mixes with publication snapshots');
    await settle(page, 3_500);

    // 7. Ontology governance and de facto vocabulary.
    await page.goto(new URL('/ontology-projects', WEBAPP_ORIGIN).toString(), { waitUntil: 'domcontentloaded' });
    await caption(page, '6 · Ontology governance', 'Capability claims bind to ontology concepts; unmapped terms surface for review');
    await settle(page, 4_000);

    // 8. Management-plane API docs.
    await page.goto(new URL('/v1/docs', API_ORIGIN).toString(), { waitUntil: 'domcontentloaded' });
    await caption(page, '7 · The management plane', 'OpenAPI 3.1 + Swagger: lifecycle, policy packages, verification, transparency');
    await settle(page, 4_500);

    // 9. Closing card.
    await page.goto(WEBAPP_ORIGIN, { waitUntil: 'domcontentloaded' });
    await caption(page, 'Verify before you load', 'registry-operator verify publication | artifact · MCP: registry.verify_publication');
    await settle(page, 5_000);
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();
    if (video) {
      const raw = await video.path();
      console.log(JSON.stringify({ ok: true, raw_video: raw }, null, 2));
    }
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
