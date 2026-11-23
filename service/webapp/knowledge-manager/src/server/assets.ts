// Design system for the knowledge-manager webapp.
//
// Modern security-SaaS look: dark-first (deep slate surfaces, subtle borders,
// violet accent) with an automatic light mode via prefers-color-scheme.
// Kept as a single self-contained stylesheet so the server-rendered Hono app
// needs no Tailwind build step.
export const APP_CSS = `:root {
  color-scheme: dark;

  /* Surfaces */
  --bg: #0a0b10;
  --header-bg: rgba(10, 11, 16, 0.82);
  --surface: #11131b;
  --surface-2: #161923;
  --surface-3: #1c202d;

  /* Borders */
  --border: rgba(148, 163, 184, 0.12);
  --border-strong: rgba(148, 163, 184, 0.24);

  /* Text */
  --text: #e8eaf2;
  --text-2: #9ba3b4;
  --text-3: #656d80;

  /* Accent — Signet violet */
  --accent: #8b5cf6;
  --accent-2: #a78bfa;
  --accent-strong: #7c3aed;
  --accent-soft: rgba(139, 92, 246, 0.14);
  --accent-border: rgba(139, 92, 246, 0.38);

  /* Tones */
  --green: #34d399;
  --green-soft: rgba(52, 211, 153, 0.12);
  --blue: #60a5fa;
  --blue-soft: rgba(96, 165, 250, 0.12);
  --amber: #fbbf24;
  --amber-soft: rgba(251, 191, 36, 0.12);
  --red: #f87171;
  --red-soft: rgba(248, 113, 113, 0.12);
  --gray-soft: rgba(148, 163, 184, 0.1);

  /* Shape + depth */
  --r-xs: 6px;
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-2: 0 18px 40px -24px rgba(0, 0, 0, 0.7);
  --glow: 0 0 0 1px rgba(139, 92, 246, 0.22), 0 8px 32px -16px rgba(124, 58, 237, 0.45);

  /* Type */
  --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;

    --bg: #f6f7fa;
    --header-bg: rgba(246, 247, 250, 0.86);
    --surface: #ffffff;
    --surface-2: #f1f3f7;
    --surface-3: #e8ebf1;

    --border: rgba(15, 23, 42, 0.09);
    --border-strong: rgba(15, 23, 42, 0.18);

    --text: #101828;
    --text-2: #475467;
    --text-3: #8a94a6;

    --accent-soft: rgba(124, 58, 237, 0.1);
    --accent-border: rgba(124, 58, 237, 0.32);

    --green: #067647;
    --green-soft: rgba(6, 118, 71, 0.1);
    --blue: #175cd3;
    --blue-soft: rgba(23, 92, 211, 0.1);
    --amber: #b54708;
    --amber-soft: rgba(181, 71, 8, 0.1);
    --red: #b42318;
    --red-soft: rgba(180, 35, 24, 0.1);
    --gray-soft: rgba(15, 23, 42, 0.06);

    --shadow-1: 0 1px 2px rgba(16, 24, 40, 0.06);
    --shadow-2: 0 16px 40px -24px rgba(16, 24, 40, 0.28);
    --glow: 0 0 0 1px rgba(124, 58, 237, 0.18), 0 8px 32px -18px rgba(124, 58, 237, 0.35);
  }
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(1100px 520px at 82% -12%, var(--accent-soft), transparent 62%),
    var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 1rem;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; border-radius: 4px; }

@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

.container {
  width: 100%;
  max-width: 80rem;
  margin-inline: auto;
  padding-inline: 1rem;
}
@media (min-width: 640px) { .container { padding-inline: 1.5rem; } }
@media (min-width: 1024px) { .container { padding-inline: 2rem; } }

a { color: var(--accent-2); text-decoration: none; transition: color 0.12s ease; }
a:hover { color: var(--accent); }
@media (prefers-color-scheme: light) {
  a { color: var(--accent-strong); }
  a:hover { color: #5b21b6; }
}

h1, h2, h3 { color: var(--text); line-height: 1.25; }
h1 { font-size: 1.75rem; font-weight: 650; letter-spacing: -0.025em; margin: 0 0 0.75rem; }
h2 { font-size: 1.125rem; font-weight: 620; letter-spacing: -0.015em; margin: 1.75rem 0 0.75rem; }
h3 { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; margin: 1.25rem 0 0.5rem; }

p { margin: 0.5rem 0; }
small { font-size: 0.8125rem; }
.muted { color: var(--text-2); }

code, pre { font-family: var(--font-mono); }
code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.08rem 0.38rem;
  border-radius: var(--r-xs);
  font-size: 0.84em;
  overflow-wrap: anywhere;
}
pre {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 1rem 1.1rem;
  border-radius: var(--r-md);
  overflow-x: auto;
  font-size: 0.8rem;
  line-height: 1.6;
  margin: 0.5rem 0;
}
pre code { background: none; border: 0; color: inherit; padding: 0; }

/* Skip link */
.skip-link {
  position: absolute;
  left: 0.5rem;
  top: -3rem;
  z-index: 50;
  background: var(--accent-strong);
  color: #fff;
  padding: 0.5rem 0.75rem;
  border-radius: var(--r-sm);
  font-size: 0.875rem;
}
.skip-link:focus { top: 0.5rem; color: #fff; }

/* Header */
.app-header {
  position: sticky;
  top: 0;
  z-index: 40;
  border-bottom: 1px solid var(--border);
  background: var(--header-bg);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.app-header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding-block: 0.7rem;
}
.brand { display: flex; align-items: center; gap: 0.65rem; flex-shrink: 0; color: var(--text); }
.brand:hover { color: var(--text); }
.brand-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.65rem;
  background: linear-gradient(135deg, #7c3aed 0%, #a855f7 55%, #8b5cf6 100%);
  color: #fff;
  box-shadow: var(--glow);
}
.brand-logo svg { display: block; }
.brand-name { font-size: 1.0625rem; font-weight: 650; letter-spacing: -0.02em; }

.app-nav { display: flex; flex: 1 1 auto; gap: 0.15rem; flex-wrap: wrap; }
.nav-link {
  display: inline-flex;
  align-items: center;
  border-radius: var(--r-sm);
  padding: 0.4rem 0.7rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-2);
  transition: background 0.12s ease, color 0.12s ease;
}
.nav-link:hover { background: var(--surface-2); color: var(--text); }
.nav-link[aria-current="page"], .nav-link[aria-current="page"]:hover {
  background: var(--accent-soft);
  color: var(--accent-2);
}
@media (prefers-color-scheme: light) {
  .nav-link[aria-current="page"], .nav-link[aria-current="page"]:hover { color: var(--accent-strong); }
}

.app-header-right { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }
.app-header-right p { margin: 0; font-size: 0.8125rem; color: var(--text-2); max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-header-right form { margin: 0; }

/* Page body */
.page { padding-top: 2rem; padding-bottom: 4rem; }
.page-title { margin-top: 0; margin-bottom: 0.35rem; }
.page-title + .muted, .hero-sub { color: var(--text-2); margin-bottom: 1.25rem; }

/* Buttons */
button, [role="button"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--r-sm);
  padding: 0.5rem 0.95rem;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 550;
  line-height: 1.25;
  background: linear-gradient(180deg, #8b5cf6, #7c3aed);
  color: #fff;
  cursor: pointer;
  text-decoration: none;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.14);
  transition: filter 0.12s ease, border-color 0.12s ease, background 0.12s ease, transform 0.12s ease;
}
button:hover, [role="button"]:hover { filter: brightness(1.08); color: #fff; }
button:active, [role="button"]:active { transform: translateY(1px); }
button.secondary, [role="button"].secondary,
button.outline, [role="button"].outline {
  background: var(--surface-2);
  color: var(--text);
  border-color: var(--border-strong);
  box-shadow: none;
  filter: none;
}
button.secondary:hover, [role="button"].secondary:hover,
button.outline:hover, [role="button"].outline:hover {
  background: var(--surface-3);
  border-color: var(--accent-border);
  color: var(--text);
  filter: none;
}
button:disabled, [role="button"][aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; }

.button-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1.25rem; }

/* Cards / panels */
.panel, .version-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  padding: 1.25rem 1.5rem;
  margin: 1rem 0;
}
.panel > h2:first-child, .version-card > h3:first-child { margin-top: 0; }

/* Dashboard tiles */
.dashboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 0.875rem;
  margin: 1.5rem 0;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-1);
  padding: 1rem 1.1rem;
  color: var(--text);
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.metric:hover {
  color: var(--text);
  border-color: var(--accent-border);
  transform: translateY(-1px);
  box-shadow: var(--shadow-2);
}
.metric .metric-top { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.metric .metric-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.6rem;
  background: var(--accent-soft);
  color: var(--accent-2);
  flex-shrink: 0;
}
@media (prefers-color-scheme: light) { .metric .metric-icon { color: var(--accent-strong); } }
.metric .value {
  display: block;
  font-size: 1.75rem;
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.metric .metric-arrow { color: var(--text-3); transition: transform 0.15s ease, color 0.15s ease; }
.metric:hover .metric-arrow { color: var(--accent-2); transform: translateX(2px); }
.metric .label { color: var(--text); font-size: 0.875rem; font-weight: 550; }
.metric small { color: var(--text-3); font-size: 0.78rem; }

/* Hero (detail pages) */
.detail-hero {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  justify-content: space-between;
  align-items: flex-start;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-1);
  padding: 1.25rem 1.5rem;
  margin: 0.75rem 0 1.25rem;
}
.detail-hero .detail-main { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }
.detail-keys { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.detail-key-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0.25rem 0.6rem;
  font-size: 0.875rem;
}
.detail-key-chip code { background: none; border: 0; padding: 0; font-size: 0.85rem; }
.detail-desc { color: var(--text-2); max-width: 48rem; margin: 0.15rem 0; }
.detail-urn { color: var(--text-3); font-size: 0.8125rem; margin: 0.1rem 0; }
.detail-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.detail-chips { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.35rem; }

/* Chips */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.16rem 0.6rem;
  font-size: 0.75rem;
  color: var(--text-2);
  font-weight: 500;
}
.chip a { color: inherit; }
.chip a:hover { color: var(--accent-2); }

/* Tabs */
.tabs-wrap { margin-top: 0.5rem; }
.tabs {
  display: inline-flex;
  gap: 0.2rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.25rem;
  margin: 0.5rem 0 1.25rem;
  flex-wrap: wrap;
  max-width: 100%;
}
.tab-btn {
  border: 0;
  background: transparent;
  box-shadow: none;
  color: var(--text-2);
  padding: 0.42rem 0.8rem;
  border-radius: 7px;
  font-size: 0.85rem;
  font-weight: 550;
  cursor: pointer;
  filter: none;
}
.tab-btn:hover { background: var(--surface-2); color: var(--text); filter: none; }
.tab-btn[aria-selected="true"], .tab-btn[aria-selected="true"]:hover {
  background: var(--accent-soft);
  color: var(--accent-2);
  filter: none;
}
@media (prefers-color-scheme: light) {
  .tab-btn[aria-selected="true"], .tab-btn[aria-selected="true"]:hover { color: var(--accent-strong); }
}
.tab-panel[hidden] { display: none; }
.tab-count { color: var(--text-3); font-size: 0.78em; font-weight: 500; margin-left: 0.3rem; }

/* Key/value grid */
.kv {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--surface);
}
.kv-row {
  display: grid;
  grid-template-columns: minmax(10rem, 13rem) minmax(0, 1fr);
  gap: 1rem;
  padding: 0.65rem 1rem;
  border-top: 1px solid var(--border);
  align-items: start;
}
.kv-row:first-child { border-top: 0; }
.kv-key { color: var(--text-3); font-size: 0.8125rem; padding-top: 0.1rem; }
.kv-value { color: var(--text); font-size: 0.875rem; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.kv-value.mono { font-family: var(--font-mono); font-size: 0.82rem; }
@media (max-width: 640px) {
  .kv-row { grid-template-columns: 1fr; gap: 0.15rem; }
  .kv-key { padding-top: 0; }
}

/* Copy buttons */
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  margin-left: 0.4rem;
  border-radius: var(--r-xs);
  border: 1px solid var(--border);
  background: var(--surface-2);
  box-shadow: none;
  color: var(--text-3);
  cursor: pointer;
  vertical-align: -0.35em;
  filter: none;
}
.copy-btn:hover { color: var(--accent-2); border-color: var(--accent-border); filter: none; }
.copy-btn svg { display: block; }
.copy-btn.copied { color: var(--green); border-color: var(--green); }

/* Lists */
.summary-list { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0; margin: 0.6rem 0; list-style: none; }
.summary-list li {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
  border-radius: 999px;
  padding: 0.14rem 0.6rem;
  font-size: 0.72rem;
  font-weight: 550;
  font-family: var(--font-mono);
}
.summary-list li::before {
  content: '';
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 999px;
  background: var(--accent-2);
  opacity: 0.85;
}

/* Tables */
.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
}
table { width: 100%; border-collapse: collapse; }
thead th {
  background: var(--surface-2);
  padding: 0.6rem 1rem;
  text-align: left;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3);
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}
tbody td {
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  color: var(--text-2);
  border-top: 1px solid var(--border);
  vertical-align: top;
}
tbody tr:first-child td { border-top: 0; }
tbody tr:hover { background: var(--surface-2); }
tbody td a { font-weight: 550; }

/* State badges */
.state-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.38rem;
  border-radius: 999px;
  padding: 0.18rem 0.6rem;
  font-size: 0.6875rem;
  font-weight: 620;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border: 1px solid transparent;
  vertical-align: middle;
}
.state-badge::before {
  content: '';
  width: 0.36rem;
  height: 0.36rem;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.9;
}
.state-badge.draft, .state-badge.archived { background: var(--gray-soft); color: var(--text-2); border-color: var(--border); }
.state-badge.validated { background: var(--blue-soft); color: var(--blue); }
.state-badge.published { background: var(--green-soft); color: var(--green); }
.state-badge.certified { background: var(--accent-soft); color: var(--accent-2); }
.state-badge.rejected, .state-badge.revoked { background: var(--red-soft); color: var(--red); }
.state-badge.deprecated { background: var(--amber-soft); color: var(--amber); }
@media (prefers-color-scheme: light) { .state-badge.certified { color: var(--accent-strong); } }

/* Messages */
.flash, .error {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0.8rem 1rem;
  font-size: 0.875rem;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.flash::before, .error::before {
  content: '';
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  flex-shrink: 0;
  transform: translateY(0.1rem);
}
.flash { background: var(--blue-soft); border-color: rgba(96, 165, 250, 0.35); color: var(--text); }
.flash::before { background: var(--blue); }
.error { background: var(--red-soft); border-color: rgba(248, 113, 113, 0.35); color: var(--text); }
.error::before { background: var(--red); }
.panel > .flash:first-child, .panel > .error:first-child { margin-top: 0; }

/* Empty state */
.empty {
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  padding: 2rem;
  text-align: center;
  color: var(--text-2);
}
.empty > p { margin-top: 0; }

/* Toolbar / breadcrumb / session */
.toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 1rem 0 0.75rem; border: 0; padding: 0; }
.toolbar input[type="search"] { max-width: 22rem; margin: 0; }
.breadcrumb { margin: 0 0 1rem; color: var(--text-3); font-size: 0.8125rem; }
.breadcrumb a { color: var(--text-2); }
.breadcrumb a:hover { color: var(--accent-2); }
.session-bar { margin: 0 0 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: 0.75rem 1rem; }
.session-bar > summary { cursor: pointer; font-size: 0.875rem; color: var(--text-2); }

/* Code panels (Fuseki queries) */
.code-panel { padding: 0; overflow: hidden; }
.code-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem 0.25rem;
}
.code-panel-head h2 { margin: 0; font-size: 1rem; }
.code-panel-body { padding: 0 1.25rem 1.25rem; }
.code-panel-body p { margin-top: 0.35rem; color: var(--text-2); }

/* Version cards */
.version-card { padding: 1.1rem 1.25rem; }
.version-card.is-active { border-color: var(--accent-border); box-shadow: var(--glow); }
.version-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.version-head h3 { margin: 0; }
.version-raw { margin: 0.75rem 0 0.25rem; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 0.15rem 0.85rem 0.5rem; background: var(--surface-2); }
.version-raw > summary { font-size: 0.8125rem; color: var(--text-2); padding: 0.5rem 0; }
.version-raw .kv { background: var(--surface); margin: 0.5rem 0; }
.lifecycle-form { margin-top: 0.75rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }
.form-inline { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 0.75rem; align-items: end; }
@media (max-width: 640px) { .form-inline { grid-template-columns: 1fr; } }
.form-inline label { margin-top: 0; }
.form-inline textarea { min-height: 0; height: 2.4rem; }

/* Auth (login) */
.auth-shell { display: flex; justify-content: center; padding: 2.5rem 0 4rem; }
.auth-card {
  width: 100%;
  max-width: 26rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  padding: 1.75rem 2rem 2rem;
}
.auth-card .auth-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0.7rem;
  background: linear-gradient(135deg, #7c3aed 0%, #a855f7 55%, #8b5cf6 100%);
  color: #fff;
  box-shadow: var(--glow);
  margin-bottom: 1rem;
}
.auth-card h2 { margin: 0 0 0.35rem; }
.auth-card form { margin-bottom: 0; }
.auth-hint { color: var(--text-3); font-size: 0.8125rem; }

/* Graph */
.graph-layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 1rem; align-items: start; }
.graph-detail-panel { margin: 0; }
#graph-detail-panel .kv-row { grid-template-columns: 1fr; gap: 0.1rem; }
#graph-detail-panel .kv-key { font-size: 0.75rem; }
.graph-canvas {
  height: 520px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  overflow: hidden;
}
.graph-controls { display: grid; grid-template-columns: minmax(0, 2fr) minmax(7rem, 1fr) auto; gap: 0.75rem; align-items: end; margin: 1rem 0; }
.graph-controls label { margin-top: 0; }
@media (max-width: 720px) { .graph-controls { grid-template-columns: 1fr; } }
.graph-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.5rem 0 0.25rem; }
fieldset.toolbar { gap: 0.5rem; }
#graph-legend { display: flex; flex-wrap: wrap; }
#graph-legend label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.28rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font-size: 0.8rem;
  color: var(--text-2);
}

details { margin: 1rem 0; }
details > summary { cursor: pointer; font-weight: 550; color: var(--text-2); }
details > summary:hover { color: var(--text); }

/* Forms */
form { margin: 1rem 0; }
label { display: block; font-size: 0.8125rem; font-weight: 550; color: var(--text-2); margin-top: 0.85rem; }
input, textarea, select {
  display: block;
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 0.875rem;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
input::placeholder, textarea::placeholder { color: var(--text-3); }
input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: none;
  border-color: var(--accent-2);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
input[type="checkbox"], input[type="radio"] { display: inline-block; width: auto; margin: 0; box-shadow: none; accent-color: var(--accent); }
textarea { min-height: 6rem; resize: vertical; }
form > button[type="submit"] { margin-top: 1rem; }

/* Footer */
.app-footer { border-top: 1px solid var(--border); padding-block: 1.75rem; color: var(--text-3); margin-top: 2rem; }
.app-footer .footer-inner { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: center; }
`;
