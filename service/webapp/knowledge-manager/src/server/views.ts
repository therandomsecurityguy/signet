import type {
  AgentDetails,
  AgentSummary,
  Freshness,
  GraphSubgraph,
  ProvenanceRecord,
  RecertificationQueue,
  SearchMatch,
  SkillVersionOperationInput,
  SkillDetails,
  SkillLifecycleOperationResult,
  SkillSummary,
  SkillVersionDetails,
  TrustScore,
} from './clients/registry-api.js';
import type { SemanticTurkeyProjectsView } from './clients/semantic-turkey.js';
// Inline page scripts. Rendered as <script>${CONSTANT}</script> so the
// response CSP (see ./app.ts) can pin each one with a sha256 hash; the
// constants are the exact rendered script text, so keep them byte-identical.
export const GRAPH_EXPLORER_SCRIPT = `(function () {
  const raw = document.getElementById('graph-data');
  const container = document.getElementById('graph-canvas');
  const detailPanel = document.getElementById('graph-detail-panel');
  if (!raw || !container || !detailPanel || typeof window.cytoscape !== 'function') return;
  const graph = JSON.parse(raw.textContent || '{}');
  const nodeMap = new Map((graph.nodes || []).map((node) => [node.urn, node]));
  const elements = [
    ...(graph.nodes || []).map((node) => ({
      data: {
        id: node.id,
        label: node.label,
        entityType: node.entity_type,
        urn: node.urn,
      },
    })),
    ...(graph.edges || []).map((edge) => ({
      data: {
        id: edge.id,
        source: edge.from_urn,
        target: edge.to_urn,
        label: edge.predicate,
      },
    })),
  ];
  const dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = dark
    ? { label: '#dfe3ee', edge: '#525b6e', edgeLabelBg: '#161923', edgeLabelText: '#9ba3b4' }
    : { label: '#334155', edge: '#94a3b8', edgeLabelBg: '#ffffff', edgeLabelText: '#475467' };
  const cy = window.cytoscape({
    container,
    elements,
    layout: {
      name: 'breadthfirst',
      directed: true,
      padding: 20,
      spacingFactor: 1.2,
    },
    style: [
      {
        selector: 'node',
        style: {
          'background-color': '#8b5cf6',
          'label': 'data(label)',
          'color': theme.label,
          'text-wrap': 'wrap',
          'text-max-width': 140,
          'font-size': 11,
          'text-valign': 'bottom',
          'text-margin-y': 8,
          'width': 26,
          'height': 26,
        },
      },
      {
        selector: 'edge',
        style: {
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'label': 'data(label)',
          'font-size': 9,
          'color': theme.edgeLabelText,
          'text-background-color': theme.edgeLabelBg,
          'text-background-opacity': 1,
          'text-background-padding': 2,
          'line-color': theme.edge,
          'target-arrow-color': theme.edge,
        },
      },
      {
        selector: 'node[entityType = "AGENT"]',
        style: { 'background-color': '#60a5fa' },
      },
      {
        selector: 'node[entityType = "SKILL"]',
        style: { 'background-color': '#34d399' },
      },
      {
        selector: 'node[entityType = "SKILL_VERSION"]',
        style: { 'background-color': '#a78bfa' },
      },
      {
        selector: 'node[entityType = "ARTIFACT"]',
        style: { 'background-color': '#fbbf24' },
      },
      {
        selector: 'node[entityType = "HARNESS"]',
        style: { 'background-color': '#f87171' },
      },
    ],
  });
  const renderDetail = (urn) => {
    const node = nodeMap.get(urn);
    if (!node) return;
    const props = Object.entries(node.properties || {})
      .map(([key, value]) => '<div class="kv-row"><span class="kv-key">' + escapeHtmlHtml(key) + '</span><div class="kv-value">' + escapeHtmlHtml(stringifyValue(value)) + '</div></div>')
      .join('');
    const actionLink = detailHref(node);
    detailPanel.innerHTML =
      '<h2>Selected Node</h2>' +
      '<p><strong>Label:</strong> ' + escapeHtmlHtml(node.label) + '</p>' +
      '<p><strong>Entity Type:</strong> ' + escapeHtmlHtml(node.entity_type) + '</p>' +
      '<p><strong>URN:</strong> <code>' + escapeHtmlHtml(node.urn) + '</code></p>' +
      (actionLink
        ? '<p><a href="' + escapeHtmlHtml(actionLink) + '">Open canonical detail page</a></p>'
        : '') +
      (props.length > 0
        ? '<div class="kv">' + props + '</div>'
        : '<p>No properties.</p>');
  };
  cy.on('tap', 'node', (event) => {
    const data = event.target.data();
    renderDetail(data.urn);
  });
  document.querySelectorAll('#graph-legend input[data-node-type]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const type = cb.getAttribute('data-node-type');
      cy.$('node[entityType = "' + type + '"]').style('display', cb.checked ? 'element' : 'none');
    });
  });
  const initialRoot = graph.root_urn || ((graph.nodes || [])[0] || {}).urn;
  if (initialRoot) renderDetail(initialRoot);
})();

function escapeHtmlHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stringifyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function detailHref(node) {
  if (!node || !node.properties) return null;
  if (node.entity_type === 'AGENT' && typeof node.properties.agent_key === 'string') {
    return '/agents/' + encodeURIComponent(node.properties.agent_key);
  }
  if (node.entity_type === 'SKILL' && typeof node.properties.skill_key === 'string') {
    return '/skills/' + encodeURIComponent(node.properties.skill_key);
  }
  if (node.entity_type === 'SKILL_VERSION' && typeof node.properties.skill_key === 'string') {
    return '/skills/' + encodeURIComponent(node.properties.skill_key);
  }
  return null;
}`;

export const SHARED_PAGE_SCRIPT = `// Client-side row filter for list pages (#table-filter + #filterable-table).
(function () {
  var input = document.getElementById('table-filter');
  var table = document.getElementById('filterable-table');
  if (!input || !table) return;
  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    rows.forEach(function (row) {
      row.hidden = q.length > 0 && row.textContent.toLowerCase().indexOf(q) === -1;
    });
  });
})();

// Copy-to-clipboard: [data-copy] buttons, or the nearest <pre> inside
// the button's .code-panel / .code-block ancestor.
(function () {
  function write(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(area); }
    return Promise.resolve();
  }
  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('.copy-btn') : null;
    if (!btn) return;
    var text = btn.getAttribute('data-copy');
    if (!text) {
      var scope = btn.closest('.code-panel') || btn.closest('.code-block');
      var pre = scope ? scope.querySelector('pre') : null;
      text = pre ? pre.textContent : '';
    }
    if (!text) return;
    write(text).then(function () {
      btn.classList.add('copied');
      window.setTimeout(function () { btn.classList.remove('copied'); }, 1200);
    }).catch(function () {});
  });
})();

// Lightweight tabs: [data-tab] buttons switch sibling [data-tab-panel]
// sections inside their .tabs-wrap. Without JS every panel stays visible.
(function () {
  document.querySelectorAll('.tabs-wrap').forEach(function (wrap) {
    var buttons = Array.prototype.slice.call(wrap.querySelectorAll('.tab-btn[data-tab]'));
    var panels = Array.prototype.slice.call(wrap.querySelectorAll('[data-tab-panel]'));
    if (buttons.length === 0 || panels.length === 0) return;
    function activate(name) {
      buttons.forEach(function (btn) {
        btn.setAttribute('aria-selected', String(btn.getAttribute('data-tab') === name));
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.getAttribute('data-tab-panel') !== name;
      });
    }
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () { activate(btn.getAttribute('data-tab')); });
    });
    var selected = buttons.filter(function (b) { return b.getAttribute('aria-selected') === 'true'; })[0] || buttons[0];
    if (selected) activate(selected.getAttribute('data-tab'));
  });
})();`;


export type PageChromeInput = {
  path?: string;
  session: {
    authenticated: boolean;
    returnTo: string;
    authMode: 'api_key' | 'okta' | 'dual';
    oktaMode: 'mock' | 'real';
    expiresAt?: string;
    flash?: string;
    error?: string;
    principalLabel?: string;
    authMethod?: 'api_key' | 'okta_access_token';
    csrfToken?: string;
  };
};

function csrfHiddenField(page?: PageChromeInput): string {
  const token = page?.session?.csrfToken;
  return token ? `<input type="hidden" name="_csrf" value="${escapeHtml(token)}" />` : '';
}

// --- shared visual helpers -------------------------------------------------

const SEAL_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M8.6 12.4l2.3 2.3 4.5-4.9"/></svg>`;

function icon(path: string, size = 16): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

const ICONS = {
  arrow: icon('<path d="M5 12h13"/><path d="M13 6.5l5.5 5.5-5.5 5.5"/>'),
  copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"/>', 14),
  agents: icon('<rect x="5" y="7.5" width="14" height="10.5" rx="2.5"/><path d="M12 7.5V4"/><path d="M9 12.5h.01M15 12.5h.01" stroke-width="2.6"/>'),
  skills: icon('<path d="M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8L12 3.5z"/><path d="M18.5 16.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z"/>'),
  graph: icon('<circle cx="6" cy="6.5" r="2.5"/><circle cx="18" cy="6.5" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.2 7.9l2.5 7.3M15.8 7.9l-2.5 7.3M8.5 6.5h7"/>'),
  ontology: icon('<path d="M5 5h10.5A2.5 2.5 0 0 1 18 7.5V19a2 2 0 0 0-2-2H5z"/><path d="M5 5v12"/>'),
  fuseki: icon('<ellipse cx="12" cy="6" rx="6.5" ry="2.8"/><path d="M5.5 6v6c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8V6"/><path d="M5.5 12v6c0 1.5 2.9 2.8 6.5 2.8s6.5-1.3 6.5-2.8v-6"/>'),
} as const;

function copyButton(value: string): string {
  return `<button type="button" class="copy-btn" data-copy="${escapeHtml(value)}" aria-label="Copy value" title="Copy">${ICONS.copy}</button>`;
}

function isMonoValue(text: string): boolean {
  return text.length > 60 || text.startsWith('urn:') || /^[0-9a-f]{16,}$/i.test(text) || text.startsWith('agk_') || text.startsWith('sha256:');
}

export function renderHome(input: {
  apiOrigin: string;
  vocbenchUiUrl?: string;
  apiDocsUrl?: string;
  mcpUrl?: string;
  counts?: { agents?: number | undefined; skills?: number | undefined };
  page?: PageChromeInput;
}) {
  const tile = (options: {
    href: string;
    icon: string;
    value?: number | undefined;
    label: string;
    hint: string;
  }) => `
    <a class="metric" href="${options.href}">
      <div class="metric-top">
        <span class="metric-icon">${options.icon}</span>
        ${
          typeof options.value === 'number'
            ? `<span class="value">${options.value}</span>`
            : `<span class="metric-arrow">${ICONS.arrow}</span>`
        }
      </div>
      <span class="label">${escapeHtml(options.label)}</span>
      <small>${escapeHtml(options.hint)}</small>
    </a>`;
  return renderPage(
    'Knowledge Manager',
    `
      <p class="hero-sub">Registry admin and ontology-authoring launchpad for the internal beta.</p>
      <div class="dashboard">
        ${tile({ href: '/agents', icon: ICONS.agents, value: input.counts?.agents, label: 'Agents', hint: 'registered' })}
        ${tile({ href: '/skills', icon: ICONS.skills, value: input.counts?.skills, label: 'Skills', hint: 'registered' })}
        ${tile({ href: '/graph', icon: ICONS.graph, label: 'Graph', hint: 'explore links' })}
        ${tile({ href: '/ontology-projects', icon: ICONS.ontology, label: 'Ontology projects', hint: 'VocBench' })}
        ${tile({ href: '/fuseki-queries', icon: ICONS.fuseki, label: 'Fuseki queries', hint: 'SPARQL shortcuts' })}
      </div>
      <div class="button-row">
        <a role="button" href="/agents/new">Register agent</a>
        <a role="button" class="secondary" href="/skills/new">Register skill</a>
        ${input.apiDocsUrl ? `<a role="button" class="outline" href="${escapeHtml(input.apiDocsUrl)}">API docs</a>` : ''}
        ${input.mcpUrl ? `<a role="button" class="outline" href="${escapeHtml(input.mcpUrl)}">MCP endpoint</a>` : ''}
      </div>
      <p><strong>Registry API:</strong> <code>${escapeHtml(input.apiOrigin)}</code> ${copyButton(input.apiOrigin)}</p>
      ${input.vocbenchUiUrl ? `<p><strong>VocBench UI:</strong> <a href="${escapeHtml(input.vocbenchUiUrl)}">${escapeHtml(input.vocbenchUiUrl)}</a></p>` : '<p class="muted">Ontology authoring (VocBench / Semantic Turkey) is not enabled in this environment.</p>'}
    `,
    input.page,
  );
}

export type Paging = { page: number; pageSize: number; hasNext: boolean; basePath: string };

function renderPager(paging?: Paging) {
  if (!paging || (paging.page <= 1 && !paging.hasNext)) return '';
  const prev =
    paging.page > 1
      ? `<a role="button" class="secondary" href="${paging.basePath}?page=${paging.page - 1}">← Previous</a>`
      : '<span></span>';
  const next = paging.hasNext
    ? `<a role="button" class="secondary" href="${paging.basePath}?page=${paging.page + 1}">Next →</a>`
    : '<span></span>';
  return `<nav class="toolbar spread">${prev}<small>Page ${paging.page}</small>${next}</nav>`;
}

export type SearchContext = {
  query: string;
  mode: 'keyword' | 'semantic';
  resultCount?: number;
  error?: string;
};

export function renderAgents(input: {
  agents: AgentSummary[];
  statusByKey?: Record<string, string>;
  matchByKey?: Record<string, SearchMatch>;
  search?: SearchContext;
  tagFilter?: string;
  paging?: Paging;
  page?: PageChromeInput;
}) {
  const status = input.statusByKey ?? {};
  const hasStatus = Object.keys(status).length > 0;
  const hasMatch = input.matchByKey !== undefined;
  const headers = ['Agent Key', 'Harness', ...(hasStatus ? ['Status'] : []), 'Trust', 'Tags', ...(hasMatch ? ['Match'] : []), 'Source Path', 'Graph'];
  const rows = input.agents.map((agent) => [
    `<a href="/agents/${encodeURIComponent(agent.agent_key)}">${escapeHtml(agent.agent_key)}</a>`,
    escapeHtml(agent.harness_name ?? ''),
    ...(hasStatus ? [renderStateBadge(status[agent.agent_key])] : []),
    renderTrustCell(agent.trust) + renderFreshnessChip(agent.freshness),
    renderTagCell(agent.tags, '/agents'),
    ...(hasMatch ? [renderMatchCell(input.matchByKey?.[agent.agent_key])] : []),
    escapeHtml(agent.source_path ?? ''),
    `<a href="/graph?root_urn=${encodeURIComponent(agent.agent_urn)}&depth=3">View graph</a>`,
  ]);
  return renderPage(
    'Agents',
    `
      <p class="breadcrumb"><a href="/">Home</a> / Agents</p>
      ${renderSearchForm({ action: '/agents', query: input.search?.query ?? '', mode: input.search?.mode ?? 'semantic', placeholder: 'Search agents…' })}
      ${renderSearchStatus(input.search)}
      ${renderTagFilter(input.tagFilter, '/agents')}
      ${input.agents.length > 0 ? '<div class="toolbar"><input type="search" id="table-filter" placeholder="Filter agents…" aria-label="Filter agents" /></div>' : ''}
      ${renderTable(headers, rows, input.search ? '' : '<a role="button" href="/agents/new">Register an agent</a>', 'filterable-table')}
      ${renderPager(input.paging)}
    `,
    input.page,
  );
}

export function renderAgentDetails(input: {
  details: AgentDetails;
  activeEvidence?: ReviewEvidenceArtifact[];
  evidenceErrors?: string[];
  provenance?: ProvenanceRecord;
  flash?: string;
  page?: PageChromeInput;
}) {
  const agentUrn = input.details.agent.urn;
  const agentKey = String(input.details.agent.properties.agent_key ?? input.details.agent.urn);
  const displayName = String(input.details.agent.properties.display_name ?? '');
  const description = String(input.details.agent.properties.description ?? '');
  const harnessName = String(input.details.agent.properties.harness_name ?? '');
  const tags = stringArrayProperty(input.details.agent.properties, 'tags');
  const detailLink = graphEntityDetailHref({
    urn: input.details.agent.urn,
    entity_type: 'AGENT',
    properties: input.details.agent.properties,
  });
  return renderPage(
    `Agent ${String(input.details.agent.properties.agent_key ?? input.details.agent.urn)}`,
    `
      <p class="breadcrumb"><a href="/agents">← Back to agents</a></p>
      ${renderFlash(input.flash)}
      <section class="detail-hero">
        <div class="detail-main">
          <div class="detail-keys">
            <span class="detail-key-chip"><code>${escapeHtml(agentKey)}</code></span>
            ${harnessName ? `<span class="chip">harness: ${escapeHtml(harnessName)}</span>` : ''}
            ${displayName ? `<span class="chip">${escapeHtml(displayName)}</span>` : ''}
          </div>
          ${description ? `<p class="detail-desc">${escapeHtml(description)}</p>` : ''}
          <p class="detail-urn">URN <code>${escapeHtml(agentUrn)}</code> ${copyButton(agentUrn)}</p>
          ${renderTagChips(tags, '/agents')}
        </div>
        <div class="detail-actions">
          <a role="button" class="secondary" href="/graph?root_urn=${encodeURIComponent(agentUrn)}&depth=3">View graph</a>
          ${detailLink ? `<a role="button" class="secondary" href="${escapeHtml(detailLink)}">Open canonical detail page</a>` : ''}
        </div>
      </section>
      <div class="tabs-wrap">
        <div class="tabs" role="tablist" aria-label="Agent sections">
          <button class="tab-btn" role="tab" type="button" data-tab="overview" aria-selected="true">Overview</button>
          <button class="tab-btn" role="tab" type="button" data-tab="skills" aria-selected="false">Skills<span class="tab-count">${input.details.skills.length}</span></button>
          <button class="tab-btn" role="tab" type="button" data-tab="harnesses" aria-selected="false">Harnesses<span class="tab-count">${input.details.harnesses.length}</span></button>
          <button class="tab-btn" role="tab" type="button" data-tab="artifacts" aria-selected="false">Artifacts<span class="tab-count">${input.details.artifacts.length}</span></button>
          <button class="tab-btn" role="tab" type="button" data-tab="history" aria-selected="false">History</button>
        </div>
        <section class="tab-panel" role="tabpanel" data-tab-panel="overview">
          <h2>Properties</h2>
          ${renderPropertiesTable(input.details.agent.properties)}
          <h2>Active Version</h2>
          ${
            input.details.active_version
              ? `
                <p><strong>Agent Version URN:</strong> <code>${escapeHtml(input.details.active_version.agent_version.urn)}</code> ${copyButton(input.details.active_version.agent_version.urn)}</p>
                ${input.details.active_version.freshness ? `<p>${renderFreshnessChip(input.details.active_version.freshness)}</p>` : ''}
                ${renderPropertiesTable(input.details.active_version.agent_version.properties)}
              `
              : '<p>No active version.</p>'
          }
          ${renderEvidenceSection(input.activeEvidence ?? [], input.evidenceErrors ?? [])}
          <h2>Curate tags</h2>
          <p class="muted">Free-form tags (comma-separated) for discovery; normalized server-side (unique, sorted).</p>
          <form method="post" action="/agents/${encodeURIComponent(agentKey)}/tags">
            ${csrfHiddenField(input.page)}
            <label for="tags">Tags</label>
            <input id="tags" name="tags" type="text" value="${escapeHtml(tags.join(', '))}" placeholder="onboarding, platform" />
            <button type="submit">Save tags</button>
          </form>
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="skills" hidden>
          <h2>Skills</h2>
          ${renderTable(
            ['Skill URN', 'Skill Key'],
            input.details.skills.map((skill) => [
              escapeHtml(skill.skill_urn),
              skill.skill_key
                ? `<a href="/skills/${encodeURIComponent(skill.skill_key)}">${escapeHtml(skill.skill_key)}</a>`
                : '',
            ]),
          )}
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="harnesses" hidden>
          <h2>Harnesses</h2>
          ${renderTable(
            ['Harness URN', 'Harness Name'],
            input.details.harnesses.map((harness) => [escapeHtml(harness.harness_urn), escapeHtml(harness.harness_name ?? '')]),
          )}
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="artifacts" hidden>
          <h2>Artifacts</h2>
          ${renderArtifactsTable(input.details.artifacts)}
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="history" hidden>
          <h2>History</h2>
          <p class="muted">Recorded governance activities for this agent, from the PROV-O replay${input.provenance ? ' (canonical provenance export digest below)' : ''}.</p>
          ${input.provenance ? renderProvenanceTimeline(input.provenance) : '<div class="empty"><p>Provenance is unavailable for this agent right now.</p></div>'}
        </section>
      </div>
    `,
    input.page,
  );
}

export function renderNewAgentForm(input?: {
  error?: string;
  values?: Record<string, string>;
  page?: PageChromeInput;
}) {
  const values = input?.values ?? {};

  return renderPage(
    'Register Agent',
    `
      <p class="breadcrumb"><a href="/">← Back</a></p>
      ${renderError(input?.error)}
      <form method="post" action="/agents/new">
        ${csrfHiddenField(input?.page)}
        ${renderTextInput('agent_key', 'Agent key', values.agent_key ?? '', 'text', true)}
        ${renderTextInput('harness_name', 'Harness name', values.harness_name ?? '')}
        ${renderTextInput('display_name', 'Display name', values.display_name ?? '')}
        ${renderTextArea('description', 'Description', values.description ?? '')}
        ${renderTextInput('source_path', 'Source path', values.source_path ?? '')}
        ${renderTextInput('artifact_original_path', 'Artifact original path', values.artifact_original_path ?? '')}
        ${renderTextInput('artifact_media_type', 'Artifact media type', values.artifact_media_type ?? 'text/markdown')}
        ${renderTextArea('artifact_content', 'Artifact content', values.artifact_content ?? '')}
        ${renderTextArea('skill_refs', 'Skill refs (one skill key or URN per line)', values.skill_refs ?? '')}
        <button type="submit">Register agent</button>
      </form>
    `,
    input?.page,
  );
}

export function renderSkills(input: {
  skills: SkillSummary[];
  statusByKey?: Record<string, string>;
  matchByKey?: Record<string, SearchMatch>;
  search?: SearchContext;
  tagFilter?: string;
  paging?: Paging;
  page?: PageChromeInput;
}) {
  const status = input.statusByKey ?? {};
  const hasStatus = Object.keys(status).length > 0;
  const hasMatch = input.matchByKey !== undefined;
  const headers = ['Skill Key', 'Display Name', ...(hasStatus ? ['Status'] : []), 'Trust', 'Tags', ...(hasMatch ? ['Match'] : []), 'Source Path', 'Graph'];
  const rows = input.skills.map((skill) => [
    `<a href="/skills/${encodeURIComponent(skill.skill_key)}">${escapeHtml(skill.skill_key)}</a>`,
    escapeHtml(skill.display_name ?? ''),
    ...(hasStatus ? [renderStateBadge(status[skill.skill_key])] : []),
    renderTrustCell(skill.trust) + renderFreshnessChip(skill.freshness),
    renderTagCell(skill.tags, '/skills'),
    ...(hasMatch ? [renderMatchCell(input.matchByKey?.[skill.skill_key])] : []),
    escapeHtml(skill.source_path ?? ''),
    `<a href="/graph?root_urn=${encodeURIComponent(skill.skill_urn)}&depth=3">View graph</a>`,
  ]);
  return renderPage(
    'Skills',
    `
      <p class="breadcrumb"><a href="/">Home</a> / Skills</p>
      ${renderSearchForm({ action: '/skills', query: input.search?.query ?? '', mode: input.search?.mode ?? 'semantic', placeholder: 'Search skills…' })}
      ${renderSearchStatus(input.search)}
      ${renderTagFilter(input.tagFilter, '/skills')}
      ${input.skills.length > 0 ? '<div class="toolbar"><input type="search" id="table-filter" placeholder="Filter skills…" aria-label="Filter skills" /></div>' : ''}
      ${renderTable(headers, rows, input.search ? '' : '<a role="button" href="/skills/new">Register a skill</a>', 'filterable-table')}
      ${renderPager(input.paging)}
    `,
    input.page,
  );
}

export function renderRecertificationQueue(input: {
  queue: RecertificationQueue;
  canReview: boolean;
  flash?: string;
  error?: string;
  registryError?: string;
  page?: PageChromeInput;
}) {
  const rows = input.queue.items.map((item) => {
    const basePath = `/recertification/${item.entity_type === 'SKILL_VERSION' ? 'skills' : 'agents'}/${encodeURIComponent(
      item.logical_key,
    )}/versions/${item.version}`;
    const detailsPath =
      item.entity_type === 'SKILL_VERSION'
        ? `/skills/${encodeURIComponent(item.logical_key)}`
        : `/agents/${encodeURIComponent(item.logical_key)}`;
    const stateChip = `<span class="chip freshness-chip ${
      item.recertification_state === 'due' ? 'freshness-stale' : 'freshness-aging'
    }" title="${escapeHtml(item.reasons.join(', '))}">${escapeHtml(item.recertification_state)}</span>`;
    const actions = input.canReview
      ? `
        <form class="lifecycle-form" method="post" action="${basePath}/revalidate">
          ${csrfHiddenField(input.page)}
          <div class="form-inline">
            ${renderTextInput('author', 'Author', '', 'text', true)}
            ${renderTextInput('certification_expires_at', 'New expiry (Recertify)', '', 'date')}
          </div>
          <div class="button-row">
            <button type="submit">Revalidate</button>
            ${
              item.lifecycle_status === 'certified'
                ? `<button type="submit" formaction="${basePath}/recertify">Recertify</button>`
                : ''
            }
          </div>
        </form>
      `
      : '<span class="muted">Sign in to act.</span>';
    return [
      `<a href="${detailsPath}">${escapeHtml(item.logical_key)}</a>`,
      escapeHtml(item.entity_type === 'SKILL_VERSION' ? 'skill' : 'agent'),
      escapeHtml(String(item.version)),
      renderStateBadge(item.lifecycle_status),
      stateChip,
      renderFreshnessChip(item.freshness),
      escapeHtml(item.reasons.join(', ')),
      item.last_revalidated_at ? escapeHtml(item.last_revalidated_at) : '<span class="muted">—</span>',
      actions,
    ];
  });
  const headers = ['Key', 'Type', 'Version', 'Status', 'Queue', 'Freshness', 'Reasons', 'Last revalidated', 'Actions'];
  return renderPage(
    'Recertification',
    `
      <p class="breadcrumb"><a href="/">Home</a> / Recertification</p>
      ${renderFlash(input.flash)}
      ${renderError(input.error)}
      ${input.registryError ? renderError(input.registryError) : ''}
      <section class="panel">
        <h1>Recertification queue</h1>
        <p class="muted">Live versions whose verification is aging (<em>approaching</em>) or stale, expired, or failed (<em>due</em>). Revalidate records a fresh validation run; Recertify additionally renews the certification (validation must pass first).</p>
        <p>${escapeHtml(String(input.queue.due_count))} due · ${escapeHtml(String(input.queue.approaching_count))} approaching · ${escapeHtml(
          String(input.queue.total),
        )} total</p>
        ${
          input.queue.items.length > 0
            ? renderTable(headers, rows)
            : '<p class="muted">Nothing needs recertification right now.</p>'
        }
      </section>
    `,
    input.page,
  );
}

export function renderSkillDetails(input: {
  details: SkillDetails;
  versions: SkillVersionDetails[];
  activeVersion: SkillVersionDetails | null;
  usedByAgents?: string[];
  activeEvidence?: ReviewEvidenceArtifact[];
  evidenceErrors?: string[];
  provenance?: ProvenanceRecord;
  flash?: string;
  lifecycleResult?: SkillLifecycleOperationResult;
  error?: string;
  formValues?: Record<string, string>;
  page?: PageChromeInput;
}) {
  const skillKey = String(input.details.skill.properties.skill_key ?? input.details.skill.urn);
  const skillUrn = input.details.skill.urn;
  const displayName = String(input.details.skill.properties.display_name ?? '');
  const description = String(input.details.skill.properties.description ?? '');
  const tags = stringArrayProperty(input.details.skill.properties, 'tags');
  const detailLink = graphEntityDetailHref({
    urn: input.details.skill.urn,
    entity_type: 'SKILL',
    properties: input.details.skill.properties,
  });
  const values = input.formValues ?? {};

  return renderPage(
    `Skill ${skillKey}`,
    `
      <p class="breadcrumb"><a href="/skills">← Back to skills</a></p>
      ${renderFlash(input.flash)}
      ${renderError(input.error)}
      <section class="detail-hero">
        <div class="detail-main">
          <div class="detail-keys">
            <span class="detail-key-chip"><code>${escapeHtml(skillKey)}</code></span>
            ${displayName ? `<span class="chip">${escapeHtml(displayName)}</span>` : ''}
            ${input.activeVersion ? renderStateBadge(skillLifecycleStatus(input.activeVersion)) : ''}
            ${renderFreshnessChip(input.activeVersion?.freshness)}
          </div>
          ${description ? `<p class="detail-desc">${escapeHtml(description)}</p>` : ''}
          <p class="detail-urn">URN <code>${escapeHtml(skillUrn)}</code> ${copyButton(skillUrn)}</p>
          ${renderTagChips(tags, '/skills')}
          ${
            input.usedByAgents && input.usedByAgents.length > 0
              ? `<div class="detail-chips"><span class="muted">Used by agents:</span> ${input.usedByAgents
                  .map((key) => `<span class="chip"><a href="/agents/${encodeURIComponent(key)}">${escapeHtml(key)}</a></span>`)
                  .join(' ')}</div>`
              : ''
          }
        </div>
        <div class="detail-actions">
          <a role="button" class="secondary" href="/graph?root_urn=${encodeURIComponent(skillUrn)}&depth=3">View graph</a>
          ${detailLink ? `<a role="button" class="secondary" href="${escapeHtml(detailLink)}">Open canonical detail page</a>` : ''}
        </div>
      </section>
      <div class="tabs-wrap">
        <div class="tabs" role="tablist" aria-label="Skill sections">
          <button class="tab-btn" role="tab" type="button" data-tab="overview" aria-selected="true">Overview</button>
          <button class="tab-btn" role="tab" type="button" data-tab="versions" aria-selected="false">Versions<span class="tab-count">${input.versions.length}</span></button>
          <button class="tab-btn" role="tab" type="button" data-tab="artifacts" aria-selected="false">Artifacts<span class="tab-count">${input.details.artifacts.length}</span></button>
          <button class="tab-btn" role="tab" type="button" data-tab="history" aria-selected="false">History</button>
          <button class="tab-btn" role="tab" type="button" data-tab="actions" aria-selected="false">Actions</button>
        </div>
        <section class="tab-panel" role="tabpanel" data-tab-panel="overview">
          <h2>Properties</h2>
          ${renderPropertiesTable(input.details.skill.properties)}
          <h2>Active Version</h2>
          ${input.activeVersion ? renderSkillVersionCard(input.activeVersion) : '<p>No active version.</p>'}
          ${renderEvidenceSection(input.activeEvidence ?? [], input.evidenceErrors ?? [])}
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="versions" hidden>
          <h2>Versions</h2>
          ${renderSkillVersionsList({
            skillKey,
            versions: input.versions,
            defaults: {
              author: values.author ?? '',
              note: values.note ?? '',
            },
            ...(input.page ? { page: input.page } : {}),
          })}
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="artifacts" hidden>
          <h2>Artifacts</h2>
          ${renderArtifactsTable(input.details.artifacts)}
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="history" hidden>
          <h2>History</h2>
          <p class="muted">Recorded governance activities for this skill, from the PROV-O replay${input.provenance ? ' (canonical provenance export digest below)' : ''}.</p>
          ${input.provenance ? renderProvenanceTimeline(input.provenance) : '<div class="empty"><p>Provenance is unavailable for this skill right now.</p></div>'}
        </section>
        <section class="tab-panel" role="tabpanel" data-tab-panel="actions" hidden>
          <h2>Curate tags</h2>
          <p class="muted">Free-form tags (comma-separated) for discovery; normalized server-side (unique, sorted).</p>
          <form method="post" action="/skills/${encodeURIComponent(skillKey)}/tags">
            ${csrfHiddenField(input.page)}
            <label for="tags">Tags</label>
            <input id="tags" name="tags" type="text" value="${escapeHtml(tags.join(', '))}" placeholder="onboarding, security" />
            <button type="submit">Save tags</button>
          </form>
          ${
            input.lifecycleResult
              ? `
                <h2>Last Operation Result</h2>
                <p><strong>Task URN:</strong> <code>${escapeHtml(input.lifecycleResult.task.task.urn)}</code> ${copyButton(input.lifecycleResult.task.task.urn)}</p>
                ${renderSkillVersionCard(input.lifecycleResult.result)}
              `
              : ''
          }
          <h2>Create Draft</h2>
          <p>This uses the lifecycle API and writes a new skill version task plus version metadata.</p>
          <form method="post" action="/skills/${encodeURIComponent(skillKey)}/drafts">
            ${csrfHiddenField(input.page)}
            ${renderTextInput('author', 'Author', values.author ?? '', 'text', true)}
            ${renderTextInput('display_name', 'Display name', values.display_name ?? '')}
            ${renderTextArea('description', 'Description', values.description ?? '')}
            ${renderTextInput('source_path', 'Source path', values.source_path ?? '')}
            ${renderTextInput('commit_sha', 'Commit SHA', values.commit_sha ?? '')}
            ${renderTextInput('git_tag', 'Git tag', values.git_tag ?? '')}
            ${renderTextInput('artifact_signature', 'Artifact signature', values.artifact_signature ?? '')}
            ${renderTextInput('artifact_original_path', 'Artifact original path', values.artifact_original_path ?? '')}
            ${renderTextInput('artifact_media_type', 'Artifact media type', values.artifact_media_type ?? 'text/markdown')}
            ${renderTextArea('artifact_content', 'Artifact content', values.artifact_content ?? '', true)}
            <button type="submit">Create draft</button>
          </form>
        </section>
      </div>
    `,
    input.page,
  );
}

export function renderNewSkillForm(input?: {
  error?: string;
  values?: Record<string, string>;
  page?: PageChromeInput;
}) {
  const values = input?.values ?? {};

  return renderPage(
    'Register Skill',
    `
      <p class="breadcrumb"><a href="/">← Back</a></p>
      ${renderError(input?.error)}
      <form method="post" action="/skills/new">
        ${csrfHiddenField(input?.page)}
        ${renderTextInput('skill_key', 'Skill key', values.skill_key ?? '', 'text', true)}
        ${renderTextInput('display_name', 'Display name', values.display_name ?? '')}
        ${renderTextArea('description', 'Description', values.description ?? '')}
        ${renderTextInput('source_path', 'Source path', values.source_path ?? '')}
        ${renderTextInput('artifact_original_path', 'Artifact original path', values.artifact_original_path ?? '')}
        ${renderTextInput('artifact_media_type', 'Artifact media type', values.artifact_media_type ?? 'text/markdown')}
        ${renderTextArea('artifact_content', 'Artifact content', values.artifact_content ?? '')}
        <button type="submit">Register skill</button>
      </form>
    `,
    input?.page,
  );
}

export function renderOntologyProjects(input: {
  ontologyPackages: Array<{
    ontology_version: string;
    ontology_kind: string;
    created_at: string;
    created_by: string;
    description?: string;
    sha256: string;
  }>;
  deFactoTerms: Array<{
    term: string;
    status: string;
    seen_count: number;
    first_seen_at: string;
    reviewed_by?: string;
    promoted_into_ontology_version?: string;
  }>;
  projectsView: SemanticTurkeyProjectsView;
  canReview?: boolean;
  registryError?: string;
  vocbenchUiUrl?: string;
  page?: PageChromeInput;
}) {
  const packagesTable = input.ontologyPackages.length
    ? renderTable(
        ['Version', 'Kind', 'Registered', 'By', 'Digest', 'Description'],
        input.ontologyPackages.map((pkg) => [
          escapeHtml(pkg.ontology_version),
          escapeHtml(pkg.ontology_kind),
          escapeHtml(pkg.created_at.slice(0, 10)),
          escapeHtml(pkg.created_by),
          `<code>${escapeHtml(pkg.sha256.slice(0, 12))}&#8230;</code>`,
          escapeHtml(pkg.description ?? ''),
        ]),
      )
    : '<div class="empty"><p>No ontology packages registered yet.</p></div>';

  const termsTable = input.deFactoTerms.length
    ? renderTable(
        ['Term', 'Status', 'Seen', 'First seen', 'Reviewed by', 'Promoted into', 'Review'],
        input.deFactoTerms.map((term) => {
          const reviewCell =
            input.canReview && term.status === 'candidate'
              ? `<form method="post" action="/ontology-projects/terms/${escapeHtml(encodeURIComponent(term.term))}/review">
                   ${csrfHiddenField(input.page)}
                   <button name="action" value="promote">Promote</button>
                   <button name="action" value="reject" class="secondary">Reject</button>
                 </form>`
              : '<span class="muted">&#8212;</span>';
          return [
            escapeHtml(term.term),
            escapeHtml(term.status),
            escapeHtml(String(term.seen_count)),
            escapeHtml(term.first_seen_at.slice(0, 10)),
            escapeHtml(term.reviewed_by ?? ''),
            escapeHtml(term.promoted_into_ontology_version ?? ''),
            reviewCell,
          ];
        }),
      )
    : '<div class="empty"><p>No de-facto terms recorded.</p></div>';

  const legacy = input.projectsView.status === 'configured'
    ? `<h2>VocBench / Semantic Turkey (optional)</h2>
       <p class="muted">External authoring front-end; drafts published here must round-trip through the registry.</p>
       ${renderTable(
         ['Project Name'],
         input.projectsView.projects.map((project) => [escapeHtml(project.name)]),
       )}
       ${input.vocbenchUiUrl ? `<p><a role="button" class="secondary" href="${escapeHtml(input.vocbenchUiUrl)}">Open VocBench</a></p>` : ''}`
    : `<p class="muted">VocBench / Semantic Turkey is not enabled in this environment; ontologies are
       governed in the registry (reviewed sources published via CI, de-facto promotion above).</p>`;

  return renderPage(
    'Ontology',
    `
      <p class="breadcrumb"><a href="/">Home</a> / Ontology</p>
      ${
        input.registryError
          ? `<div class="empty"><p>Registry ontology state unavailable: ${escapeHtml(input.registryError)}</p></div>`
          : ''
      }
      <section class="panel">
        <h2>Ontology packages</h2>
        <p class="muted">Versioned ontology packages (registry_shape / skill_area) resolved by <code>ontology_version</code>; certification binds to these.</p>
        ${packagesTable}
      </section>
      <section class="panel">
        <h2>De-facto vocabulary</h2>
        <p class="muted">Candidate concepts observed in publications. Promoting a term records the human review; normative changes ship as new ontology packages via CI.</p>
        ${termsTable}
      </section>
      ${legacy}
    `,
    input.page,
  );
}

// --- reviews ----------------------------------------------------------------

export type ReviewEvidenceArtifact = {
  sha256: string;
  payload: unknown;
};

export type ReviewPropertyDiff = {
  changed: Array<{ key: string; from: string; to: string }>;
  added: string[];
  removed: string[];
};

export type ReviewQueueItem = {
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  logical_key: string;
  version: number | null;
  publication_urn: string;
  lifecycle_status: string;
  review_status: string;
  policy_version?: string;
  detail_href?: string;
  diff: ReviewPropertyDiff | null;
  diff_base_version: number | null;
  evidence: ReviewEvidenceArtifact[];
  evidence_errors: string[];
  artifacts: Array<{ role: string; sha256: string }>;
  action_href: string;
};

export function renderReviews(input: {
  items: ReviewQueueItem[];
  flash?: string;
  error?: string;
  page?: PageChromeInput;
}) {
  const validatedCount = input.items.filter((item) => item.lifecycle_status === 'validated').length;
  return renderPage(
    'Reviews',
    `
      <p class="breadcrumb"><a href="/">Home</a> / Reviews</p>
      ${renderFlash(input.flash)}
      ${renderError(input.error)}
      <p class="hero-sub">${escapeHtml(String(input.items.length))} version${input.items.length === 1 ? '' : 's'} awaiting human review across skills and agents${
        validatedCount > 0 ? ` · ${escapeHtml(String(validatedCount))} ready to publish once approved` : ''
      }. Approvals satisfy the policy human-review gate; decisions are recorded as review evidence artifacts.</p>
      ${
        input.items.length === 0
          ? '<div class="empty"><p>Review queue is clear.</p></div>'
          : input.items.map((item) => renderReviewCard(item, input.page)).join('')
      }
    `,
    input.page,
  );
}

function renderReviewCard(item: ReviewQueueItem, page?: PageChromeInput) {
  const title = item.detail_href
    ? `<a href="${escapeHtml(item.detail_href)}">${escapeHtml(item.logical_key)}</a>`
    : escapeHtml(item.logical_key);
  const versionLabel = item.version !== null ? `Version ${escapeHtml(String(item.version))}` : escapeHtml(item.publication_urn);
  return `
    <section class="panel version-card review-card">
      <div class="version-head">
        <h3>${title} <span class="muted">·</span> ${versionLabel}</h3>
        ${renderStateBadge(item.lifecycle_status)}
        ${renderStateBadge(item.review_status)}
        ${item.policy_version ? `<span class="chip">policy: ${escapeHtml(item.policy_version)}</span>` : ''}
      </div>
      <p class="detail-urn">URN <code>${escapeHtml(item.publication_urn)}</code> ${copyButton(item.publication_urn)}</p>
      ${renderReviewDiff(item)}
      ${item.evidence.map((artifact) => renderReviewEvidence(artifact)).join('')}
      ${item.evidence_errors.map((message) => `<p class="error">${escapeHtml(message)}</p>`).join('')}
      ${
        item.artifacts.length > 0
          ? `<p class="detail-chips">${item.artifacts
              .map(
                (artifact) =>
                  `<span class="chip">${escapeHtml(artifact.role)} · <code>${escapeHtml(artifact.sha256.slice(0, 10))}…</code> ${copyButton(artifact.sha256)}</span>`,
              )
              .join(' ')}</p>`
          : ''
      }
      <form class="lifecycle-form" method="post" action="${escapeHtml(item.action_href)}">
        ${csrfHiddenField(page)}
        <div class="form-inline">
          ${renderTextInput('author', 'Reviewer', '', 'text', true)}
          ${renderTextInput('review_role', 'Review role', '', 'text')}
        </div>
        ${renderTextArea('note', 'Note', '')}
        <div class="button-row">
          <button type="submit" name="decision" value="approve">Approve</button>
          <button type="submit" name="decision" value="reject" class="secondary">Reject</button>
        </div>
      </form>
    </section>
  `;
}

function renderReviewDiff(item: ReviewQueueItem) {
  if (item.diff_base_version === null || !item.diff) {
    return `
      <details class="version-raw">
        <summary>No previous version to compare</summary>
        <p class="muted">This is the first recorded version of ${escapeHtml(item.logical_key)}.</p>
      </details>
    `;
  }
  const { changed, added, removed } = item.diff;
  const summary = `Changes vs version ${escapeHtml(String(item.diff_base_version))} · ${changed.length} changed · ${added.length} added · ${removed.length} removed`;
  const hasChanges = changed.length + added.length + removed.length > 0;
  return `
    <details class="version-raw"${hasChanges ? ' open' : ''}>
      <summary>${summary}</summary>
      ${
        hasChanges
          ? `
            ${
              changed.length > 0
                ? `<div class="kv">${changed
                    .map(
                      (change) => `
                        <div class="kv-row">
                          <span class="kv-key">${escapeHtml(change.key)}</span>
                          <div class="kv-value"><span class="muted" title="${escapeHtml(change.from)}">${escapeHtml(truncateText(change.from, 140))}</span> → <span title="${escapeHtml(change.to)}">${escapeHtml(truncateText(change.to, 140))}</span></div>
                        </div>
                      `,
                    )
                    .join('')}</div>`
                : ''
            }
            ${added.length > 0 ? `<p class="detail-chips"><span class="muted">Added:</span> ${added.map((key) => `<span class="chip">${escapeHtml(key)}</span>`).join(' ')}</p>` : ''}
            ${removed.length > 0 ? `<p class="detail-chips"><span class="muted">Removed:</span> ${removed.map((key) => `<span class="chip">${escapeHtml(key)}</span>`).join(' ')}</p>` : ''}
          `
          : '<p class="muted">Properties are identical to the previous version.</p>'
      }
    </details>
  `;
}

function renderReviewEvidence(artifact: ReviewEvidenceArtifact) {
  const unwrapped = unwrapArtifactPayload(artifact.payload);
  const shortSha = `${artifact.sha256.slice(0, 10)}…`;
  if (!unwrapped) {
    return `
      <section class="review-evidence">
        <div class="evidence-head"><h4>Evidence artifact</h4><span class="chip">sha256:${escapeHtml(shortSha)}</span></div>
        <p class="muted">Artifact content is not a structured report; inspect it by digest.</p>
      </section>
    `;
  }

  if (unwrapped['validator_kind'] === 'llm_semantic' || unwrapped['advisory'] === true || Array.isArray(unwrapped['scorecards'])) {
    return renderAdvisoryEvidence(unwrapped, shortSha);
  }

  if (Array.isArray(unwrapped['layers']) || typeof unwrapped['conforms'] === 'boolean') {
    return renderShaclEvidence(unwrapped, shortSha);
  }

  const fields = primitiveEntries(unwrapped);
  return `
    <section class="review-evidence">
      <div class="evidence-head"><h4>Evidence artifact</h4><span class="chip">sha256:${escapeHtml(shortSha)}</span></div>
      ${
        fields.length > 0
          ? `<div class="kv">${fields
              .map(
                ([label, value]) => `
                  <div class="kv-row"><span class="kv-key">${escapeHtml(label)}</span><div class="kv-value">${escapeHtml(value)}</div></div>
                `,
              )
              .join('')}</div>`
          : '<p class="muted">No structured fields to display.</p>'
      }
    </section>
  `;
}

function renderShaclEvidence(payload: Record<string, unknown>, shortSha: string) {
  const validator = typeof payload['validator'] === 'string' ? payload['validator'] : 'shacl';
  const engine = typeof payload['engine'] === 'string' ? payload['engine'] : '';
  const validatedAt = typeof payload['validated_at'] === 'string' ? payload['validated_at'] : '';
  const conforms = payload['conforms'] === true;
  const layers = Array.isArray(payload['layers']) ? payload['layers'] : [];
  const rdf = isRecord(payload['rdf']) ? payload['rdf'] : null;
  const reportJson = rdf && isRecord(rdf['report']) ? rdf['report'] : null;
  return `
    <section class="review-evidence">
      <div class="evidence-head">
        <h4>Validation report</h4>
        <span class="chip">${escapeHtml(validator)}</span>
        ${conforms ? '<span class="state-badge approved">conforms</span>' : '<span class="state-badge rejected">violations</span>'}
        ${engine ? `<span class="chip">${escapeHtml(engine)}</span>` : ''}
        ${validatedAt ? `<span class="chip muted-chip">${escapeHtml(validatedAt)}</span>` : ''}
        <span class="chip">sha256:${escapeHtml(shortSha)}</span>
      </div>
      <div class="kv">
        ${layers
          .map((layer) => {
            const record = isRecord(layer) ? layer : {};
            const name = typeof record['layer'] === 'string' ? record['layer'] : 'layer';
            const violations = Array.isArray(record['violations']) ? record['violations'] : [];
            const details = primitiveEntries(record, ['layer', 'violations']);
            const candidates = Array.isArray(record['candidates'])
              ? record['candidates'].filter((entry) => isRecord(entry))
              : [];
            return `
              <div class="kv-row">
                <span class="kv-key">${escapeHtml(name)}</span>
                <div class="kv-value">
                  ${details.length > 0 ? details.map(([label, value]) => `<span class="chip">${escapeHtml(label)}: ${escapeHtml(value)}</span>`).join(' ') : ''}
                  ${candidates.map((candidate) => renderDuplicateCandidate(candidate)).join('')}
                  ${
                    violations.length === 0
                      ? '<span class="muted">no violations</span>'
                      : violations.map((violation) => `<p class="violation">${escapeHtml(describeViolation(violation))}</p>`).join('')
                  }
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
      ${
        reportJson
          ? `<details class="version-raw"><summary>Standardized sh:ValidationReport (JSON-LD)</summary><pre>${escapeHtml(JSON.stringify(reportJson, null, 2))}</pre></details>`
          : ''
      }
    </section>
  `;
}

// Advisory duplicate candidates (dedupe layer): surfaced like violations but
// in the advisory tone — evidence, never a validation failure.
function renderDuplicateCandidate(candidate: Record<string, unknown>): string {
  const key = typeof candidate['logical_key'] === 'string' ? candidate['logical_key'] : '?';
  const score = typeof candidate['score'] === 'number' ? candidate['score'] : null;
  const sharedClaims = Array.isArray(candidate['shared_claims'])
    ? candidate['shared_claims'].filter((claim): claim is string => typeof claim === 'string')
    : [];
  const parts = [
    `possible duplicate: ${key}`,
    score !== null ? `score ${score}` : '',
    sharedClaims.length > 0 ? `shares ${sharedClaims.join(', ')}` : '',
    candidate['phrase_match'] === true ? 'near-identical description' : '',
  ].filter(Boolean);
  return `<p class="advisory-line">${escapeHtml(parts.join(' · '))}</p>`;
}

function renderEvidenceSection(evidence: ReviewEvidenceArtifact[], errors: string[]): string {
  if (evidence.length === 0 && errors.length === 0) {
    return '';
  }
  return `
    <h2>Validation evidence</h2>
    ${evidence.map((artifact) => renderReviewEvidence(artifact)).join('')}
    ${errors.map((message) => `<p class="error">${escapeHtml(message)}</p>`).join('')}
  `;
}

function renderProvenanceTimeline(provenance: ProvenanceRecord): string {
  const statusChips = [
    provenance.current_provenance_signed
      ? '<span class="state-badge approved">signed · current</span>'
      : '<span class="chip muted-chip">export unsigned</span>',
    provenance.all_provenance_signatures_verified
      ? '<span class="state-badge approved">all signatures verified</span>'
      : provenance.provenance_signatures.length > 0
        ? '<span class="state-badge rejected">signature issues</span>'
        : '',
    `<span class="chip">canonical ${escapeHtml(provenance.evidence.canonical_rdf_sha256.slice(0, 12))}… ${copyButton(provenance.evidence.canonical_rdf_sha256)}</span>`,
  ]
    .filter(Boolean)
    .join(' ');

  const items = provenance.replay
    .map(
      (entry) => `
        <div class="timeline-item">
          <span class="timeline-dot" aria-hidden="true"></span>
          <div class="timeline-body">
            <div class="timeline-head">
              <strong class="timeline-op">${escapeHtml(entry.operation)}</strong>
              ${renderStateBadge(entry.status)}
              ${entry.occurred_at ? `<span class="muted">${escapeHtml(entry.occurred_at)}</span>` : ''}
            </div>
            <div class="timeline-meta">
              ${entry.actor ? `<span>by ${escapeHtml(entry.actor)}</span>` : ''}
              <span class="chip" title="${escapeHtml(entry.version_urn)}">${escapeHtml(shortVersionLabel(entry.version_urn))}</span>
            </div>
          </div>
        </div>
      `,
    )
    .join('');

  const derivation = provenance.derivation_chain.filter((entry) => entry.was_derived_from.length > 0);
  return `
    <p class="detail-chips">${statusChips}</p>
    ${provenance.replay.length > 0 ? `<div class="timeline">${items}</div>` : '<div class="empty"><p>No recorded activities yet.</p></div>'}
    ${
      derivation.length > 0
        ? `<h3>Derivation</h3>${derivation
            .map(
              (entry) => `
                <p class="detail-urn">${escapeHtml(shortVersionLabel(entry.version_urn))} ← ${entry.was_derived_from
                  .map((urn) => `<span class="chip" title="${escapeHtml(urn)}">${escapeHtml(shortVersionLabel(urn))}</span>`)
                  .join(' ')}</p>
              `,
            )
            .join('')}`
        : ''
    }
  `;
}

function shortVersionLabel(urn: string): string {
  for (const prefix of ['urn:sg:skill-version:', 'urn:sg:agent-version:']) {
    if (urn.startsWith(prefix)) return urn.slice(prefix.length);
  }
  return urn;
}

function renderAdvisoryEvidence(payload: Record<string, unknown>, shortSha: string) {
  const validator = typeof payload['validator'] === 'string' ? payload['validator'] : 'advisory';
  const confidence = typeof payload['confidence'] === 'number' ? payload['confidence'] : null;
  const scorecards = Array.isArray(payload['scorecards']) ? payload['scorecards'] : [];
  const warnings = Array.isArray(payload['warnings']) ? payload['warnings'].filter((entry) => typeof entry === 'string') : [];
  const suggestions = isRecord(payload['suggestions']) ? payload['suggestions'] : null;
  const suggestionLines: string[] = [];
  if (suggestions) {
    for (const [key, value] of Object.entries(suggestions)) {
      if (Array.isArray(value) && value.length > 0) {
        suggestionLines.push(`${key}: ${value.map((entry) => stringifyValue(entry)).join(', ')}`);
      }
    }
  }
  return `
    <section class="review-evidence">
      <div class="evidence-head">
        <h4>Advisory semantic analysis</h4>
        <span class="chip">${escapeHtml(validator)}</span>
        ${confidence !== null ? `<span class="chip">confidence ${escapeHtml(String(Math.round(confidence * 100)))}%</span>` : ''}
        <span class="chip muted-chip">advisory — never blocking</span>
        <span class="chip">sha256:${escapeHtml(shortSha)}</span>
      </div>
      ${
        scorecards.length > 0
          ? `<div class="kv">${scorecards
              .map((scorecard) => {
                const record = isRecord(scorecard) ? scorecard : {};
                const dimension = typeof record['dimension'] === 'string' ? record['dimension'] : 'dimension';
                const score = typeof record['score'] === 'number' ? record['score'] : null;
                const rationale = typeof record['rationale'] === 'string' ? record['rationale'] : '';
                return `
                  <div class="kv-row">
                    <span class="kv-key">${escapeHtml(dimension)}</span>
                    <div class="kv-value">${score !== null ? `<strong>${escapeHtml(String(score))}</strong> · ` : ''}${escapeHtml(rationale)}</div>
                  </div>
                `;
              })
              .join('')}</div>`
          : ''
      }
      ${warnings.map((warning) => `<p class="violation">warning: ${escapeHtml(warning)}</p>`).join('')}
      ${suggestionLines.map((line) => `<p class="muted">${escapeHtml(line)}</p>`).join('')}
    </section>
  `;
}

function unwrapArtifactPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const inner = payload['payload'];
  if (isRecord(inner)) return inner;
  return payload;
}

function primitiveEntries(record: Record<string, unknown>, exclude: string[] = []): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (exclude.includes(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push([key, stringifyValue(value)]);
    }
  }
  return out.sort(([left], [right]) => left.localeCompare(right));
}

function describeViolation(violation: unknown): string {
  if (!isRecord(violation)) return stringifyValue(violation);
  const severity = typeof violation['severity'] === 'string' ? violation['severity'] : '';
  const message =
    typeof violation['message'] === 'string'
      ? violation['message']
      : typeof violation['result_message'] === 'string'
        ? violation['result_message']
        : '';
  if (!severity && !message) {
    return stringifyValue(violation);
  }
  const path = typeof violation['path'] === 'string' ? violation['path'] : '';
  const focus =
    typeof violation['focus_node'] === 'string'
      ? violation['focus_node']
      : typeof violation['focusNode'] === 'string'
        ? violation['focusNode']
        : '';
  return [severity ? `${severity}:` : '', message, path ? `(${path})` : '', focus ? `@ ${focus}` : '']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export function renderFusekiQueries(input: {
  page?: PageChromeInput;
  fusekiUrl: string;
  datasetName: string;
}) {
  const queries = [
    {
      title: 'Count Nodes By Entity Type',
      description: 'Quickly see how many agents, skills, skill versions, artifacts, and tasks are present.',
      query: `PREFIX sgmeta: <urn:sg:meta:>

SELECT ?entity_type (COUNT(?urn) AS ?count)
WHERE {
  ?urn sgmeta:entityType ?entity_type .
}
GROUP BY ?entity_type
ORDER BY ?entity_type`,
    },
    {
      title: 'List Agents',
      description: 'Show the logical agent nodes and their JSON property blobs.',
      query: `PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn sgmeta:entityType "AGENT" ;
       sgmeta:properties ?props .
}
ORDER BY STR(?urn)`,
    },
    {
      title: 'List Skills',
      description: 'Show the logical skill nodes and their JSON property blobs.',
      query: `PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn sgmeta:entityType "SKILL" ;
       sgmeta:properties ?props .
}
ORDER BY STR(?urn)`,
    },
    {
      title: 'List Skill Versions',
      description: 'Inspect published/draft versions and see active version metadata.',
      query: `PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn sgmeta:entityType "SKILL_VERSION" ;
       sgmeta:properties ?props .
}
ORDER BY STR(?urn)`,
    },
    {
      title: 'Artifact Linking Edges',
      description: 'See which agents or skill versions point at artifacts.',
      query: `PREFIX sgmeta: <urn:sg:meta:>

SELECT ?from ?predicate ?to
WHERE {
  ?edge sgmeta:from ?from ;
        sgmeta:to ?to ;
        sgmeta:predicate ?predicate .
  FILTER (?predicate IN ("sg:implementedBy", "sg:definedBy"))
}
ORDER BY STR(?from) STR(?to)`,
    },
  ];

  return renderPage(
    'Fuseki Query Shortcuts',
    `
      <p class="breadcrumb"><a href="/">← Back</a></p>
      <p>Use these copy-paste queries in Fuseki for the current metadata backend.</p>
      <p><strong>Fuseki UI:</strong> <a href="${escapeHtml(input.fusekiUrl)}">${escapeHtml(input.fusekiUrl)}</a> <small class="muted">(cluster-internal; reachable from inside the cluster, not a browser in production)</small></p>
      <p><strong>Dataset:</strong> <code>${escapeHtml(input.datasetName)}</code></p>
      <p><strong>Full query pack:</strong> <code>docs/fuseki-query-pack.md</code></p>
      ${queries
        .map(
          (item) => `
            <section class="panel code-panel">
              <div class="code-panel-head">
                <h2>${escapeHtml(item.title)}</h2>
                <button type="button" class="copy-btn" aria-label="Copy query" title="Copy query">${ICONS.copy}</button>
              </div>
              <div class="code-panel-body">
                <p>${escapeHtml(item.description)}</p>
                <pre>${escapeHtml(item.query)}</pre>
              </div>
            </section>
          `,
        )
        .join('')}
    `,
    input.page,
  );
}

export function renderGraphPage(input: {
  graph: GraphSubgraph;
  defaults: {
    rootUrn: string;
    depth: number;
  };
  error?: string;
  rootSuggestions?: Array<{ urn: string; label: string }>;
  page?: PageChromeInput;
}) {
  const graphJson = serializeJsonForScript(input.graph);
  const initialNode = input.graph.nodes.find((node) => node.urn === input.graph.root_urn) ?? input.graph.nodes[0] ?? null;
  const suggestions =
    input.rootSuggestions && input.rootSuggestions.length > 0
      ? `<p>Pick an existing root:</p><ul>${input.rootSuggestions
          .map(
            (entry) =>
              `<li><a href="/graph?root_urn=${encodeURIComponent(entry.urn)}">${escapeHtml(entry.label)}</a> <code>${escapeHtml(entry.urn)}</code></li>`,
          )
          .join('')}</ul>`
      : '';
  return renderPage(
    'Graph Explorer',
    `
      <p class="breadcrumb"><a href="/">← Back</a></p>
      ${renderError(input.error)}
      ${suggestions}
      <p>Thin visual explorer for the current registry graph read model. This view is rooted and curated through <code>service/api</code>, not a raw browser-to-Fuseki integration.</p>
      <form class="graph-controls" method="get" action="/graph">
        <div>${renderTextInput('root_urn', 'Root URN', input.defaults.rootUrn, 'text', true)}</div>
        <div>${renderTextInput('depth', 'Depth (1-5)', String(input.defaults.depth), 'number', true)}</div>
        <div><button type="submit">Load graph</button></div>
      </form>
      <div class="graph-meta">
        <span class="chip">Nodes: ${escapeHtml(String(input.graph.nodes.length))}</span>
        <span class="chip">Edges: ${escapeHtml(String(input.graph.edges.length))}</span>
      </div>
      <fieldset class="toolbar" id="graph-legend" aria-label="Filter node types">
        <label><input type="checkbox" data-node-type="AGENT" checked /> Agent</label>
        <label><input type="checkbox" data-node-type="SKILL" checked /> Skill</label>
        <label><input type="checkbox" data-node-type="SKILL_VERSION" checked /> Version</label>
        <label><input type="checkbox" data-node-type="ARTIFACT" checked /> Artifact</label>
        <label><input type="checkbox" data-node-type="HARNESS" checked /> Harness</label>
      </fieldset>
      <div class="graph-layout">
        <div id="graph-canvas" class="graph-canvas"></div>
        <aside id="graph-detail-panel" class="panel graph-detail-panel">
          <h2>Selected Node</h2>
          ${
            initialNode
              ? renderGraphNodeDetail(initialNode)
              : '<p>No node selected.</p>'
          }
        </aside>
      </div>
      <p><strong>Root:</strong> <code>${escapeHtml(input.graph.root_urn)}</code></p>
      <details>
        <summary>Node summary</summary>
        ${renderTable(
          ['Label', 'Entity Type', 'URN'],
          input.graph.nodes.map((node) => [
            escapeHtml(node.label),
            escapeHtml(node.entity_type),
            `<code>${escapeHtml(node.urn)}</code>`,
          ]),
        )}
      </details>
      <details>
        <summary>Edge summary</summary>
        ${renderTable(
          ['From', 'Predicate', 'To'],
          input.graph.edges.map((edge) => [
            `<code>${escapeHtml(edge.from_urn)}</code>`,
            escapeHtml(edge.predicate),
            `<code>${escapeHtml(edge.to_urn)}</code>`,
          ]),
        )}
      </details>
      <script type="application/json" id="graph-data">${graphJson}</script>
      <script src="/assets/cytoscape.min.js"></script>
      <script>${GRAPH_EXPLORER_SCRIPT}</script>
    `,
    input.page,
  );
}

function navItem(href: string, label: string, active: string, key: string) {
  const current = active === key ? ' aria-current="page"' : '';
  return `<a class="nav-link" href="${href}"${current}>${label}</a>`;
}

function activeNavKey(path?: string): string {
  if (!path || path === '/') return 'home';
  if (path.startsWith('/agents')) return 'agents';
  if (path.startsWith('/skills')) return 'skills';
  if (path.startsWith('/reviews')) return 'reviews';
  if (path.startsWith('/recertification')) return 'recertification';
  if (path.startsWith('/graph')) return 'graph';
  if (path.startsWith('/ontology')) return 'ontology';
  if (path.startsWith('/fuseki')) return 'fuseki';
  return '';
}

function renderPage(title: string, body: string, page?: PageChromeInput) {
  const active = activeNavKey(page?.path);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · Signet</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%237c3aed'/%3E%3Cpath d='M5.2 8.4l1.9 1.9 3.7-4.1' stroke='white' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="app-header">
      <div class="container app-header-inner">
        <a class="brand" href="/">
          <span class="brand-logo" aria-hidden="true">${SEAL_SVG}</span>
          <span class="brand-name">Signet</span>
        </a>
        <nav class="app-nav" aria-label="Primary">
          ${navItem('/', 'Home', active, 'home')}
          ${navItem('/agents', 'Agents', active, 'agents')}
          ${navItem('/skills', 'Skills', active, 'skills')}
          ${navItem('/reviews', 'Reviews', active, 'reviews')}
          ${navItem('/recertification', 'Recertification', active, 'recertification')}
          ${navItem('/graph', 'Graph', active, 'graph')}
          ${navItem('/ontology-projects', 'Ontology', active, 'ontology')}
          ${navItem('/fuseki-queries', 'Fuseki', active, 'fuseki')}
        </nav>
        <div class="app-header-right">
          ${page?.session?.principalLabel ? `<p title="${escapeHtml(page.session.principalLabel)}">${escapeHtml(page.session.principalLabel)}</p>` : ''}
          ${
            page?.session?.authenticated
              ? `<form method="post" action="/session/logout">${csrfHiddenField(page)}<input type="hidden" name="return_to" value="${escapeHtml(page.session.returnTo)}" /><button type="submit" class="secondary">Sign out</button></form>`
              : '<a role="button" class="secondary" href="/login">Sign in</a>'
          }
        </div>
      </div>
    </header>
    <main class="container page" id="content">
      <h1 class="page-title">${escapeHtml(title)}</h1>
      ${page ? renderBanner(page.session) : ''}
      ${body}
    </main>
    <footer class="container app-footer">
      <div class="footer-inner">
        <small>Signet registry · internal beta</small>
        <small class="muted">Sealed · logged · verifiable</small>
      </div>
    </footer>
    <script>${SHARED_PAGE_SCRIPT}</script>
  </body>
</html>`;
}

function renderStateBadge(state: string | undefined) {
  if (!state) return '';
  const key = String(state).toLowerCase().replace(/[^a-z_]/g, '');
  const label = key === 'none' ? 'no active version' : String(state);
  return `<span class="state-badge ${escapeHtml(key)}">${escapeHtml(label)}</span>`;
}

// Compact trust-rank indicator: the score with the components (tier,
// lifecycle status, recency) exposed in the tooltip — never a black box.
function renderTrustCell(trust: TrustScore | undefined) {
  if (!trust) {
    return '<span class="muted">—</span>';
  }
  const parts = [`tier ${trust.tier_weight} (${trust.lifecycle_status})`];
  if (trust.recency_days !== null) {
    parts.push(`${trust.recency_days}d since certification/publication`);
  } else {
    parts.push('no certification/publication timestamp');
  }
  parts.push(`score ${trust.score}`);
  return `<span class="chip" title="${escapeHtml(parts.join(' · '))}">${escapeHtml(trust.score.toFixed(1))}</span>`;
}

// Staleness signal (build plan 2.1). Renders nothing when the version has no
// verification timestamp — "never verified" is not the same as "stale".
function renderFreshnessChip(freshness: Freshness | undefined): string {
  if (!freshness) return '';
  const label = freshness.certification_expired
    ? `expired · ${freshness.age_days}d`
    : freshness.freshness === 'stale'
      ? `stale · ${freshness.age_days}d`
      : freshness.freshness === 'aging'
        ? `aging · ${freshness.age_days}d`
        : `verified ${freshness.age_days}d ago`;
  const parts = [
    `freshness: ${freshness.freshness}`,
    `verified ${freshness.age_days}d ago (${freshness.verification_basis})`,
  ];
  if (freshness.certification_expires_at) {
    parts.push(
      freshness.certification_expired
        ? `certification expired ${Math.abs(freshness.expires_in_days ?? 0)}d ago`
        : `certification expires in ${freshness.expires_in_days}d`,
    );
  }
  if (freshness.reasons.length > 0) {
    parts.push(`reasons: ${freshness.reasons.join(',')}`);
  }
  return `<span class="chip freshness-chip freshness-${freshness.freshness}" title="${escapeHtml(parts.join(' · '))}">${escapeHtml(label)}</span>`;
}

function stringArrayProperty(properties: Record<string, unknown>, key: string): string[] {
  const value = properties[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// Tags are the curation primitive; chips link into the tag-filtered list.
function renderTagCell(tags: string[] | undefined, basePath: string) {
  if (!tags || tags.length === 0) {
    return '<span class="muted">—</span>';
  }
  const visible = tags
    .slice(0, 2)
    .map((tag) => `<a class="chip" href="${basePath}?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`);
  const overflow = tags.length > 2 ? ` <span class="muted">+${tags.length - 2}</span>` : '';
  return `${visible.join(' ')}${overflow}`;
}

function renderTagChips(tags: string[], basePath: string, label = 'tags'): string {
  if (tags.length === 0) return '';
  return `<div class="detail-chips"><span class="muted">${escapeHtml(label)}:</span> ${tags
    .map((tag) => `<span class="chip"><a href="${basePath}?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a></span>`)
    .join(' ')}</div>`;
}

function renderTagFilter(tagFilter: string | undefined, basePath: string): string {
  if (!tagFilter) return '';
  return `<p class="detail-chips"><span class="muted">filtered by tag:</span> <span class="chip">${escapeHtml(tagFilter)}</span> <a href="${basePath}">clear</a></p>`;
}

function renderSearchForm(input: {
  action: string;
  query: string;
  mode: 'keyword' | 'semantic';
  placeholder: string;
}) {
  return `
    <form class="search-form" method="get" action="${input.action}">
      <input type="search" name="q" value="${escapeHtml(input.query)}" placeholder="${escapeHtml(input.placeholder)}" aria-label="Search query" />
      <select name="mode" aria-label="Search mode">
        <option value="semantic"${input.mode === 'semantic' ? ' selected' : ''}>Semantic</option>
        <option value="keyword"${input.mode === 'keyword' ? ' selected' : ''}>Keyword</option>
      </select>
      <button type="submit">Search</button>
    </form>
  `;
}

function renderSearchStatus(search: SearchContext | undefined) {
  if (!search) return '';
  if (search.error) {
    return renderError(search.error);
  }
  const count = search.resultCount ?? 0;
  const modeLabel = search.mode === 'semantic' ? 'semantic' : 'keyword';
  return `<p class="muted">${escapeHtml(String(count))} ${modeLabel} match${count === 1 ? '' : 'es'} for “${escapeHtml(search.query)}”${
    search.mode === 'semantic' ? ' · relevance-ordered, trust score as tie-breaker' : ' · trust-ordered'
  }.</p>`;
}

// Match indicator for search results: matched concept claims plus the mode
// and score with terms in the tooltip.
function renderMatchCell(match: SearchMatch | undefined) {
  if (!match) {
    return '<span class="muted">—</span>';
  }
  const title = [
    `score ${match.score}`,
    match.phrase_match ? 'phrase match' : '',
    match.matched_terms.length > 0 ? `terms: ${match.matched_terms.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const claimChips = match.matched_claims
    .slice(0, 2)
    .map((claim) => `<span class="chip">${escapeHtml(claim)}</span> `)
    .join('');
  return `${claimChips}<span class="chip" title="${escapeHtml(title)}">${escapeHtml(match.mode)} ${escapeHtml(String(match.score))}</span>`;
}

function renderTable(headers: string[], rows: string[][], emptyAction = '', tableId = '') {
  if (rows.length === 0) {
    return `<div class="empty"><p>No entries found.</p>${emptyAction}</div>`;
  }
  const idAttr = tableId ? ` id="${tableId}"` : '';
  return `
    <div class="table-scroll">
      <table class="striped"${idAttr}>
        <thead>
          <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows
            .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderPropertiesTable(properties: Record<string, unknown>) {
  const rows = Object.entries(properties)
    .map(([key, value]) => {
      const text = stringifyValue(value);
      const mono = typeof value !== 'string' || isMonoValue(text);
      return `
        <div class="kv-row">
          <span class="kv-key">${escapeHtml(key)}</span>
          <div class="kv-value${mono ? ' mono' : ''}">${escapeHtml(text)}${copyButton(text)}</div>
        </div>
      `;
    })
    .join('');
  if (!rows) {
    return '<div class="empty"><p>No properties.</p></div>';
  }
  return `<div class="kv">${rows}</div>`;
}

function renderArtifactsTable(artifacts: Array<{ artifact_urn: string; sha256?: string }>) {
  return renderTable(
    ['Artifact URN', 'SHA256'],
    artifacts.map((artifact) => [
      `<code>${escapeHtml(artifact.artifact_urn)}</code> ${copyButton(artifact.artifact_urn)}`,
      artifact.sha256
        ? `<code>${escapeHtml(artifact.sha256)}</code> ${copyButton(artifact.sha256)}`
        : '<span class="muted">—</span>',
    ]),
  );
}

function renderGraphNodeDetail(node: GraphSubgraph['nodes'][number]) {
  const detailHref = graphEntityDetailHref(node);
  return `
    <p><strong>Label:</strong> ${escapeHtml(node.label)}</p>
    <p><strong>Entity Type:</strong> ${escapeHtml(node.entity_type)}</p>
    <p><strong>URN:</strong> <code>${escapeHtml(node.urn)}</code> ${copyButton(node.urn)}</p>
    ${detailHref ? `<p><a href="${escapeHtml(detailHref)}">Open canonical detail page</a></p>` : ''}
    ${renderPropertiesTable(node.properties)}
  `;
}

function graphEntityDetailHref(node: {
  urn: string;
  entity_type: string;
  properties: Record<string, unknown>;
}) {
  if (node.entity_type === 'AGENT') {
    const agentKey = stringProperty(node.properties, 'agent_key');
    return agentKey ? `/agents/${encodeURIComponent(agentKey)}` : null;
  }
  if (node.entity_type === 'SKILL' || node.entity_type === 'SKILL_VERSION') {
    const skillKey = stringProperty(node.properties, 'skill_key');
    return skillKey ? `/skills/${encodeURIComponent(skillKey)}` : null;
  }
  return null;
}

function serializeJsonForScript(value: unknown) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function renderSkillVersionsList(input: {
  skillKey: string;
  versions: SkillVersionDetails[];
  defaults: SkillVersionOperationInput;
  page?: PageChromeInput;
}) {
  if (input.versions.length === 0) {
    return '<p>No versions found.</p>';
  }

  const ordered = [...input.versions].sort((left, right) => skillVersionNumber(right) - skillVersionNumber(left));
  return ordered
    .map((version) => {
      const versionNumber = skillVersionNumber(version);
      const availableActions = lifecycleActions(version);

      return `
        <section class="version-card${isVersionActive(version) ? ' is-active' : ''}">
          <div class="version-head">
            <h3>Version ${escapeHtml(String(versionNumber))}</h3>
            ${renderStateBadge(skillLifecycleStatus(version))}
            ${isVersionActive(version) ? '<span class="state-badge published">active</span>' : ''}
          </div>
          ${renderSkillVersionSummary(version)}
          ${renderSkillVersionCard(version)}
          ${
            availableActions.length > 0
              ? renderLifecycleActionForm({
                  skillKey: input.skillKey,
                  versionNumber,
                  defaults: input.defaults,
                  actions: availableActions,
                  ...(input.page ? { page: input.page } : {}),
                })
              : '<p class="muted">No lifecycle actions available for this version.</p>'
          }
        </section>
      `;
    })
    .join('');
}

function renderSkillVersionCard(version: SkillVersionDetails) {
  return `
    <p class="detail-urn"><strong>Version URN:</strong> <code>${escapeHtml(version.skill_version.urn)}</code> ${copyButton(version.skill_version.urn)}</p>
    <details class="version-raw">
      <summary>Version metadata &amp; artifacts</summary>
      ${renderPropertiesTable(version.skill_version.properties)}
      <h3>Artifacts</h3>
      ${renderArtifactsTable(version.artifacts)}
      <h3>Upstream Versions</h3>
      ${renderTable(
        ['Skill Version URN'],
        version.upstream_versions.map((upstream) => [`<code>${escapeHtml(upstream.skill_version_urn)}</code>`]),
      )}
    </details>
  `;
}

function renderSkillVersionSummary(version: SkillVersionDetails) {
  const tags = [
    `status:${skillLifecycleStatus(version)}`,
    `active:${isVersionActive(version) ? 'yes' : 'no'}`,
    `certified:${isVersionCertified(version) ? 'yes' : 'no'}`,
    `artifacts:${version.artifacts.length}`,
    `upstream:${version.upstream_versions.length}`,
  ];

  const certifiedBy = stringProperty(version.skill_version.properties, 'certified_by');
  const certifiedAt = stringProperty(version.skill_version.properties, 'certified_at');
  if (certifiedBy) tags.push(`certified_by:${certifiedBy}`);
  if (certifiedAt) tags.push(`certified_at:${certifiedAt}`);

  const freshness = version.freshness ? `<li>${renderFreshnessChip(version.freshness)}</li>` : '';
  return `<ul class="summary-list">${tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join('')}${freshness}</ul>`;
}

function renderLifecycleActionForm(input: {
  skillKey: string;
  versionNumber: number;
  defaults: SkillVersionOperationInput;
  actions: Array<'validate' | 'revalidate' | 'publish' | 'promote' | 'deprecate' | 'certify' | 'recertify'>;
  page?: PageChromeInput;
}) {
  const expiryField = input.actions.includes('recertify')
    ? renderTextInput('certification_expires_at', 'New certification expiry (optional)', '', 'date')
    : '';
  return `
    <form class="lifecycle-form" method="post" action="/skills/${encodeURIComponent(input.skillKey)}/versions/${input.versionNumber}/${input.actions[0]}">
      ${csrfHiddenField(input.page)}
      <div class="form-inline">
        ${renderTextInput('author', 'Author', input.defaults.author ?? '', 'text', true)}
        ${renderTextArea('note', 'Note', input.defaults.note ?? '')}
        ${expiryField}
      </div>
      <div class="button-row">
        ${input.actions
          .map(
            (action) =>
              `<button type="submit" formaction="/skills/${encodeURIComponent(input.skillKey)}/versions/${input.versionNumber}/${action}">${escapeHtml(
                lifecycleActionLabel(action),
              )}</button>`,
          )
          .join('')}
      </div>
    </form>
  `;
}

function renderBanner(input: PageChromeInput['session']) {
  const flash = renderFlash(input.flash);
  const error = renderError(input.error);
  if (!flash && !error) return '';
  return `<section class="panel">${flash}${error}</section>`;
}

export function renderLoginPage(input: { page?: PageChromeInput }) {
  const session = input.page?.session;
  return renderPage(
    'Sign in',
    `
      <div class="auth-shell">
        <div class="auth-card">
          <span class="auth-logo" aria-hidden="true">${SEAL_SVG}</span>
          ${session ? renderUnauthenticatedSessionPanel(session) : '<p>Sign in is not configured.</p>'}
        </div>
      </div>
    `,
    input.page,
  );
}

function renderUnauthenticatedSessionPanel(input: PageChromeInput['session']) {
  if (input.authMode === 'api_key') {
    return `
      <h2>Sign in to Signet</h2>
      <p class="auth-hint">Local API-key mode is enabled. Sign in with a bearer token minted by <code>service/api</code>. The webapp stores it server-side behind an HttpOnly cookie.</p>
      <form method="post" action="/session/login">
        <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
        ${renderTextInput('api_token', 'API bearer token', '', 'password', true)}
        <button type="submit">Start session</button>
      </form>
    `;
  }

  if (input.oktaMode === 'mock') {
    return `
      <h2>Sign in to Signet</h2>
      <p class="auth-hint">Mock Okta mode is enabled. Start a simulated internal-user session over the same <code>service/api</code> auth boundary.</p>
      <form method="post" action="/session/login">
        <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
        <button type="submit">Start mock Okta session</button>
      </form>
    `;
  }

  return `
    <h2>Sign in to Signet</h2>
    <p class="auth-hint">Use the internal Okta login path to acquire a browser session aligned to the <code>service/api</code> access-token flow.</p>
    <form method="post" action="/session/login">
      <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
      <button type="submit">Sign in with Okta</button>
    </form>
  `;
}

function skillVersionNumber(version: SkillVersionDetails) {
  const raw = version.skill_version.properties.version ?? version.skill_version.properties.version_number;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function skillLifecycleStatus(version: SkillVersionDetails) {
  const raw = version.skill_version.properties.lifecycle_status ?? version.skill_version.properties.lifecycle_state;
  return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

function isVersionActive(version: SkillVersionDetails) {
  return version.skill_version.properties.active === true;
}

function isVersionCertified(version: SkillVersionDetails) {
  return version.skill_version.properties.certified === true;
}

function lifecycleActions(
  version: SkillVersionDetails,
): Array<'validate' | 'revalidate' | 'publish' | 'promote' | 'deprecate' | 'certify' | 'recertify'> {
  const status = skillLifecycleStatus(version);
  const active = isVersionActive(version);
  const certified = isVersionCertified(version);

  if (status === 'draft') return ['validate'];
  if (status === 'validated') return ['publish'];
  if (status === 'published') {
    const actions: Array<'validate' | 'revalidate' | 'publish' | 'promote' | 'deprecate' | 'certify' | 'recertify'> = [];
    if (!active) actions.push('promote');
    actions.push('deprecate');
    if (!certified) actions.push('certify');
    actions.push('revalidate');
    return actions;
  }
  if (status === 'certified') return ['revalidate', 'recertify'];

  return [];
}

function lifecycleActionLabel(
  action: 'validate' | 'revalidate' | 'publish' | 'promote' | 'deprecate' | 'certify' | 'recertify',
) {
  switch (action) {
    case 'validate':
      return 'Validate';
    case 'revalidate':
      return 'Revalidate';
    case 'publish':
      return 'Publish';
    case 'promote':
      return 'Promote';
    case 'deprecate':
      return 'Deprecate';
    case 'certify':
      return 'Certify';
    case 'recertify':
      return 'Recertify';
  }
}

function stringProperty(properties: Record<string, unknown>, key: string) {
  const value = properties[key];
  return typeof value === 'string' ? value : '';
}

function renderTextInput(
  name: string,
  label: string,
  value: string,
  type = 'text',
  required = false,
) {
  return `
    <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
    <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}" ${
      required ? 'required' : ''
    } />
  `;
}

function renderTextArea(name: string, label: string, value: string, required = false) {
  return `
    <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
    <textarea id="${escapeHtml(name)}" name="${escapeHtml(name)}" ${required ? 'required' : ''}>${escapeHtml(value)}</textarea>
  `;
}

function renderFlash(message?: string) {
  return message ? `<p class="flash">${escapeHtml(message)}</p>` : '';
}

function renderError(message?: string) {
  return message ? `<p class="error">${escapeHtml(message)}</p>` : '';
}

function stringifyValue(value: unknown) {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized ?? '';
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
