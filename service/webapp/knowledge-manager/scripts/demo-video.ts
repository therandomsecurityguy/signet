/**
 * Records the knowledge-manager demo walkthrough as a video.
 *
 * Drives the running local demo (scripts/demo-local.sh demo) with a real
 * browser, walks the governance surfaces (login → dashboard → skills →
 * skill detail → graph → agents → ontology projects → OpenAPI docs), and
 * overlays a caption bar so the recording is self-explaining. Playwright
 * captures WebM; convert to MP4 with ffmpeg:
 *
 *   ffmpeg -y -i data/demo-video/signet-demo-raw.webm \
 *     -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart \
 *     ~/Downloads/signet-demo.mp4
 *
 * Env: WEBAPP_ORIGIN (default http://localhost:3200),
 *      API_ORIGIN (default http://localhost:3100),
 *      VIDEO_DIR (default data/demo-video under the webapp package).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { chromium, type Page } from 'playwright';

const WEBAPP_ORIGIN = process.env.WEBAPP_ORIGIN ?? 'http://localhost:3200';
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3100';
const VIDEO_DIR = process.env.VIDEO_DIR ?? path.resolve(process.cwd(), 'data/demo-video');

const VIEWPORT = { width: 1280, height: 720 };

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

async function main(): Promise<void> {
  mkdirSync(VIDEO_DIR, { recursive: true });
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
