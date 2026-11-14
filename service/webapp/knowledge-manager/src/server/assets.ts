// Design system for the knowledge-manager webapp.
//
// Mirrors the look and feel of the khalifa dashboard (stock Tailwind v3
// defaults: sky-100 header bars on sky-200 borders, indigo-600 accents,
// white cards with shadow, orange-50 table headers, rounded-full tone
// badges). Kept as a single self-contained stylesheet so the server-rendered
// Hono app needs no Tailwind build step.
export const APP_CSS = `:root {
  color-scheme: light;
  --gray-50: #f9fafb;
  --gray-100: #f3f4f6;
  --gray-200: #e5e7eb;
  --gray-300: #d1d5db;
  --gray-500: #6b7280;
  --gray-600: #4b5563;
  --gray-700: #374151;
  --gray-900: #111827;
  --sky-50: #f0f9ff;
  --sky-100: #e0f2fe;
  --sky-200: #bae6fd;
  --indigo-50: #eef2ff;
  --indigo-600: #4f46e5;
  --indigo-700: #4338ca;
  --indigo-900: #312e81;
  --orange-50: #fff7ed;
  --orange-100: #ffedd5;
  --blue-50: #eff6ff;
  --blue-100: #dbeafe;
  --blue-200: #bfdbfe;
  --blue-800: #1e40af;
  --green-50: #f0fdf4;
  --green-100: #dcfce7;
  --green-200: #bbf7d0;
  --green-800: #166534;
  --red-50: #fef2f2;
  --red-100: #fee2e2;
  --red-200: #fecaca;
  --red-800: #991b1b;
  --yellow-50: #fefce8;
  --yellow-100: #fef9c3;
  --yellow-200: #fef08a;
  --yellow-800: #854d0e;
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--gray-50);
  color: var(--gray-900);
  font-family: var(--font-sans);
  font-size: 1rem;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

:focus-visible { outline: 2px solid var(--indigo-600); outline-offset: 2px; }

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

a { color: var(--indigo-600); text-decoration: none; }
a:hover { color: var(--indigo-900); }

h1, h2, h3 { color: var(--gray-900); line-height: 1.25; }
h1 { font-size: 1.875rem; font-weight: 700; margin: 0 0 1rem; }
h2 { font-size: 1.25rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
h3 { font-size: 1.05rem; font-weight: 600; margin: 1rem 0 0.5rem; }

p { margin: 0.5rem 0; }
small { font-size: 0.8rem; }
.muted { color: var(--gray-500); }

code, pre { font-family: var(--font-mono); }
code {
  background: var(--gray-100);
  color: var(--gray-800);
  padding: 0.1rem 0.35rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
  word-break: break-word;
}
pre {
  background: var(--gray-900);
  color: var(--gray-100);
  padding: 1rem;
  border-radius: 0.5rem;
  overflow-x: auto;
  font-size: 0.8rem;
  line-height: 1.5;
}
pre code { background: none; color: inherit; padding: 0; }

/* Skip link */
.skip-link {
  position: absolute;
  left: 0.5rem;
  top: -3rem;
  z-index: 50;
  background: var(--gray-900);
  color: #fff;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
}
.skip-link:focus { top: 0.5rem; color: #fff; }

/* Header */
.app-header { border-bottom: 1px solid var(--sky-200); background: var(--sky-100); }
.app-header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding-block: 0.75rem;
}
.brand { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; color: var(--gray-900); }
.brand:hover { color: var(--gray-900); }
.brand-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0.5rem;
  background: var(--indigo-600);
  color: #fff;
  font-weight: 700;
  font-size: 1.1rem;
}
.brand-name { font-size: 1.125rem; font-weight: 600; letter-spacing: -0.01em; }

.app-nav { display: flex; flex: 1 1 auto; gap: 0.25rem; flex-wrap: wrap; }
.nav-link {
  display: inline-flex;
  align-items: center;
  border-radius: 0.375rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
  background: var(--sky-100);
  color: var(--gray-700);
}
.nav-link:hover { background: var(--sky-200); color: var(--gray-900); }
.nav-link[aria-current="page"] { background: var(--gray-900); color: #fff; }
.nav-link[aria-current="page"]:hover { background: var(--gray-900); color: #fff; }

.app-header-right { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }
.app-header-right p { margin: 0; font-size: 0.875rem; color: var(--gray-600); max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-header-right form { margin: 0; }

/* Page body */
.page { padding-top: 1.5rem; padding-bottom: 3rem; }
.page-title { margin-top: 0; }

/* Buttons */
button, [role="button"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  padding: 0.5rem 1rem;
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25;
  background: var(--indigo-600);
  color: #fff;
  cursor: pointer;
  text-decoration: none;
}
button:hover, [role="button"]:hover { background: var(--indigo-700); color: #fff; }
button.secondary, [role="button"].secondary,
button.outline, [role="button"].outline {
  background: #fff;
  color: var(--gray-700);
  border-color: var(--gray-300);
}
button.secondary:hover, [role="button"].secondary:hover,
button.outline:hover, [role="button"].outline:hover {
  background: var(--gray-50);
  color: var(--gray-700);
}
button:disabled, [role="button"][aria-disabled="true"] { opacity: 0.6; cursor: not-allowed; }

.button-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }

/* Cards */
.panel, .version-card {
  background: #fff;
  border-radius: 0.5rem;
  box-shadow: var(--shadow);
  padding: 1.5rem;
  margin: 1rem 0;
}
.panel > h2:first-child, .version-card > h3:first-child { margin-top: 0; }

/* Dashboard tiles */
.dashboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  margin: 1.5rem 0;
}
.metric {
  display: block;
  background: #fff;
  border-radius: 0.5rem;
  box-shadow: var(--shadow-sm);
  padding: 1rem;
  color: var(--gray-900);
}
.metric:hover { color: var(--gray-900); }
.metric .value { display: block; font-size: 1.875rem; font-weight: 700; line-height: 1.1; }
.metric .label { color: var(--gray-600); font-size: 0.875rem; }

/* Lists */
.summary-list { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0; margin: 0.5rem 0; list-style: none; }
.summary-list li {
  background: var(--gray-100);
  color: var(--gray-800);
  border-radius: 999px;
  padding: 0.125rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 500;
}

/* Tables */
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
thead th {
  background: var(--orange-50);
  padding: 0.75rem 1.5rem;
  text-align: left;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--gray-500);
  white-space: nowrap;
}
tbody td {
  padding: 1rem 1.5rem;
  font-size: 0.875rem;
  color: var(--gray-700);
  border-top: 1px solid var(--gray-200);
}
tbody tr:hover { background: var(--gray-50); }

/* State badges */
.state-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 0.125rem 0.625rem;
  font-size: 0.72rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.state-badge.draft, .state-badge.archived { background: var(--gray-100); color: var(--gray-800); }
.state-badge.validated { background: var(--blue-100); color: var(--blue-800); }
.state-badge.published { background: var(--green-100); color: var(--green-800); }
.state-badge.certified { background: var(--indigo-50); color: var(--indigo-700); }
.state-badge.rejected, .state-badge.revoked { background: var(--red-100); color: var(--red-800); }
.state-badge.deprecated { background: var(--yellow-100); color: var(--yellow-800); }

/* Messages */
.flash {
  border: 1px solid var(--blue-200);
  background: var(--blue-50);
  color: var(--blue-800);
  padding: 1rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
}
.error {
  border: 1px solid var(--red-200);
  background: var(--red-50);
  color: var(--red-800);
  padding: 1rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
}

/* Empty state */
.empty {
  background: #fff;
  border-radius: 0.5rem;
  box-shadow: var(--shadow-sm);
  padding: 2rem;
  text-align: center;
  color: var(--gray-500);
}

/* Toolbar / breadcrumb / session */
.toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 1rem 0 0.5rem; border: 0; padding: 0; }
.toolbar input[type="search"] { max-width: 22rem; margin: 0; }
.breadcrumb { margin: 0 0 1rem; color: var(--gray-600); font-size: 0.875rem; }
.session-bar { margin: 0 0 1rem; background: #fff; border-radius: 0.5rem; box-shadow: var(--shadow-sm); padding: 0.75rem 1rem; }
.session-bar > summary { cursor: pointer; font-size: 0.875rem; color: var(--gray-700); }

/* Graph */
.graph-layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 1rem; align-items: start; }
.graph-detail-panel { margin: 0; }
#graph-canvas { border-radius: 0.5rem; }
fieldset.toolbar { gap: 1rem; }
fieldset.toolbar label { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.875rem; color: var(--gray-700); }

details { margin: 1rem 0; }
details > summary { cursor: pointer; font-weight: 500; }

/* Forms */
form { margin: 1rem 0; }
label { display: block; font-size: 0.875rem; font-weight: 500; color: var(--gray-700); margin-top: 0.75rem; }
input, textarea, select {
  display: block;
  width: 100%;
  margin-top: 0.25rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--gray-300);
  border-radius: 0.375rem;
  background: #fff;
  color: var(--gray-900);
  font: inherit;
  font-size: 0.875rem;
  box-shadow: var(--shadow-sm);
}
input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--indigo-600); outline-offset: 1px; }
input[type="checkbox"], input[type="radio"] { display: inline-block; width: auto; margin: 0; box-shadow: none; }
textarea { min-height: 6rem; resize: vertical; }
form > button[type="submit"] { margin-top: 1rem; }

/* Footer */
.app-footer { border-top: 1px solid var(--gray-200); padding-block: 1.5rem; color: var(--gray-500); }
`;
