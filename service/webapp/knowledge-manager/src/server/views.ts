import type {
  AgentDetails,
  AgentSummary,
  GraphSubgraph,
  SkillVersionOperationInput,
  SkillDetails,
  SkillLifecycleOperationResult,
  SkillSummary,
  SkillVersionDetails,
} from './clients/registry-api.js';
import type { SemanticTurkeyProjectsView } from './clients/semantic-turkey.js';

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
  };
};

export function renderHome(input: {
  apiOrigin: string;
  vocbenchUiUrl?: string;
  apiDocsUrl?: string;
  mcpUrl?: string;
  counts?: { agents?: number | undefined; skills?: number | undefined };
  page?: PageChromeInput;
}) {
  const card = (label: string, value: number | undefined, href: string, hint: string) =>
    `<a class="metric" href="${href}"><span class="value">${typeof value === 'number' ? value : '→'}</span><span class="label">${escapeHtml(label)}</span><br /><small class="label">${escapeHtml(hint)}</small></a>`;
  return renderPage(
    'Knowledge Manager',
    `
      <p class="muted">Registry admin and ontology-authoring launchpad for the internal beta.</p>
      <div class="dashboard">
        ${card('Agents', input.counts?.agents, '/agents', 'registered')}
        ${card('Skills', input.counts?.skills, '/skills', 'registered')}
        ${card('Graph', undefined, '/graph', 'explore links')}
        ${card('Ontology projects', undefined, '/ontology-projects', 'VocBench')}
        ${card('Fuseki queries', undefined, '/fuseki-queries', 'SPARQL shortcuts')}
      </div>
      <div class="button-row">
        <a role="button" href="/agents/new">Register agent</a>
        <a role="button" class="secondary" href="/skills/new">Register skill</a>
        ${input.apiDocsUrl ? `<a role="button" class="outline" href="${escapeHtml(input.apiDocsUrl)}">API docs</a>` : ''}
        ${input.mcpUrl ? `<a role="button" class="outline" href="${escapeHtml(input.mcpUrl)}">MCP endpoint</a>` : ''}
      </div>
      <p><strong>Registry API:</strong> <code>${escapeHtml(input.apiOrigin)}</code></p>
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
  return `<nav class="toolbar" style="justify-content: space-between;">${prev}<small>Page ${paging.page}</small>${next}</nav>`;
}

export function renderAgents(input: {
  agents: AgentSummary[];
  statusByKey?: Record<string, string>;
  paging?: Paging;
  page?: PageChromeInput;
}) {
  const status = input.statusByKey ?? {};
  const hasStatus = Object.keys(status).length > 0;
  const headers = ['Agent Key', 'Harness', ...(hasStatus ? ['Status'] : []), 'Source Path', 'Graph'];
  const rows = input.agents.map((agent) => [
    `<a href="/agents/${encodeURIComponent(agent.agent_key)}">${escapeHtml(agent.agent_key)}</a>`,
    escapeHtml(agent.harness_name ?? ''),
    ...(hasStatus ? [renderStateBadge(status[agent.agent_key])] : []),
    escapeHtml(agent.source_path ?? ''),
    `<a href="/graph?root_urn=${encodeURIComponent(agent.agent_urn)}&depth=3">View graph</a>`,
  ]);
  return renderPage(
    'Agents',
    `
      <p class="breadcrumb"><a href="/">Home</a> / Agents</p>
      ${input.agents.length > 0 ? '<div class="toolbar"><input type="search" id="table-filter" placeholder="Filter agents…" aria-label="Filter agents" /></div>' : ''}
      ${renderTable(headers, rows, '<a role="button" href="/agents/new">Register an agent</a>', 'filterable-table')}
      ${renderPager(input.paging)}
    `,
    input.page,
  );
}

export function renderAgentDetails(input: {
  details: AgentDetails;
  flash?: string;
  page?: PageChromeInput;
}) {
  const agentUrn = input.details.agent.urn;
  const detailLink = graphEntityDetailHref({
    urn: input.details.agent.urn,
    entity_type: 'AGENT',
    properties: input.details.agent.properties,
  });
  return renderPage(
    `Agent ${String(input.details.agent.properties.agent_key ?? input.details.agent.urn)}`,
    `
      <p><a href="/agents">Back to agents</a></p>
      ${renderFlash(input.flash)}
      <p><a href="/graph?root_urn=${encodeURIComponent(agentUrn)}&depth=3">View graph</a></p>
      ${detailLink ? `<p><a href="${escapeHtml(detailLink)}">Open canonical detail page</a></p>` : ''}
      <h2>Properties</h2>
      ${renderPropertiesTable(input.details.agent.properties)}
      <h2>Active Version</h2>
      ${
        input.details.active_version
          ? `
            <p><strong>Agent Version URN:</strong> <code>${escapeHtml(input.details.active_version.agent_version.urn)}</code></p>
            ${renderPropertiesTable(input.details.active_version.agent_version.properties)}
          `
          : '<p>No active version.</p>'
      }
      <h2>Harnesses</h2>
      ${renderTable(
        ['Harness URN', 'Harness Name'],
        input.details.harnesses.map((harness) => [escapeHtml(harness.harness_urn), escapeHtml(harness.harness_name ?? '')]),
      )}
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
      <h2>Artifacts</h2>
      ${renderArtifactsTable(input.details.artifacts)}
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
      <p><a href="/">Back</a></p>
      ${renderError(input?.error)}
      <form method="post" action="/agents/new">
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
  paging?: Paging;
  page?: PageChromeInput;
}) {
  const status = input.statusByKey ?? {};
  const hasStatus = Object.keys(status).length > 0;
  const headers = ['Skill Key', 'Display Name', ...(hasStatus ? ['Status'] : []), 'Source Path', 'Graph'];
  const rows = input.skills.map((skill) => [
    `<a href="/skills/${encodeURIComponent(skill.skill_key)}">${escapeHtml(skill.skill_key)}</a>`,
    escapeHtml(skill.display_name ?? ''),
    ...(hasStatus ? [renderStateBadge(status[skill.skill_key])] : []),
    escapeHtml(skill.source_path ?? ''),
    `<a href="/graph?root_urn=${encodeURIComponent(skill.skill_urn)}&depth=3">View graph</a>`,
  ]);
  return renderPage(
    'Skills',
    `
      <p class="breadcrumb"><a href="/">Home</a> / Skills</p>
      ${input.skills.length > 0 ? '<div class="toolbar"><input type="search" id="table-filter" placeholder="Filter skills…" aria-label="Filter skills" /></div>' : ''}
      ${renderTable(headers, rows, '<a role="button" href="/skills/new">Register a skill</a>', 'filterable-table')}
      ${renderPager(input.paging)}
    `,
    input.page,
  );
}

export function renderSkillDetails(input: {
  details: SkillDetails;
  versions: SkillVersionDetails[];
  activeVersion: SkillVersionDetails | null;
  usedByAgents?: string[];
  flash?: string;
  lifecycleResult?: SkillLifecycleOperationResult;
  error?: string;
  formValues?: Record<string, string>;
  page?: PageChromeInput;
}) {
  const skillKey = String(input.details.skill.properties.skill_key ?? input.details.skill.urn);
  const skillUrn = input.details.skill.urn;
  const detailLink = graphEntityDetailHref({
    urn: input.details.skill.urn,
    entity_type: 'SKILL',
    properties: input.details.skill.properties,
  });
  const values = input.formValues ?? {};

  return renderPage(
    `Skill ${skillKey}`,
    `
      <p><a href="/skills">Back to skills</a></p>
      ${renderFlash(input.flash)}
      ${renderError(input.error)}
      <p><a href="/graph?root_urn=${encodeURIComponent(skillUrn)}&depth=3">View graph</a></p>
      ${detailLink ? `<p><a href="${escapeHtml(detailLink)}">Open canonical detail page</a></p>` : ''}
      ${
        input.usedByAgents && input.usedByAgents.length > 0
          ? `<p><strong>Used by agents:</strong> ${input.usedByAgents
              .map((key) => `<a href="/agents/${encodeURIComponent(key)}">${escapeHtml(key)}</a>`)
              .join(', ')}</p>`
          : ''
      }
      <h2>Properties</h2>
      ${renderPropertiesTable(input.details.skill.properties)}
      <h2>Artifacts</h2>
      ${renderArtifactsTable(input.details.artifacts)}
      <h2>Active Version</h2>
      ${input.activeVersion ? renderSkillVersionCard(input.activeVersion) : '<p>No active version.</p>'}
      <h2>Versions</h2>
      ${renderSkillVersionsList({
        skillKey,
        versions: input.versions,
        defaults: {
          author: values.author ?? '',
          note: values.note ?? '',
        },
      })}
      ${
        input.lifecycleResult
          ? `
            <h2>Last Operation Result</h2>
            <p><strong>Task URN:</strong> <code>${escapeHtml(input.lifecycleResult.task.task.urn)}</code></p>
            ${renderSkillVersionCard(input.lifecycleResult.result)}
          `
          : ''
      }
      <h2>Create Draft</h2>
      <p>This uses the lifecycle API and writes a new skill version task plus version metadata.</p>
      <form method="post" action="/skills/${encodeURIComponent(skillKey)}/drafts">
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
      <p><a href="/">Back</a></p>
      ${renderError(input?.error)}
      <form method="post" action="/skills/new">
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
      <h2>Ontology packages</h2>
      <p class="muted">Versioned ontology packages (registry_shape / skill_area) resolved by <code>ontology_version</code>; certification binds to these.</p>
      ${packagesTable}
      <h2>De-facto vocabulary</h2>
      <p class="muted">Candidate concepts observed in publications. Promoting a term records the human review; normative changes ship as new ontology packages via CI.</p>
      ${termsTable}
      ${legacy}
    `,
    input.page,
  );
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
      query: `PREFIX tgmeta: <urn:tg:meta:>

SELECT ?entity_type (COUNT(?urn) AS ?count)
WHERE {
  ?urn tgmeta:entityType ?entity_type .
}
GROUP BY ?entity_type
ORDER BY ?entity_type`,
    },
    {
      title: 'List Agents',
      description: 'Show the logical agent nodes and their JSON property blobs.',
      query: `PREFIX tgmeta: <urn:tg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn tgmeta:entityType "AGENT" ;
       tgmeta:properties ?props .
}
ORDER BY STR(?urn)`,
    },
    {
      title: 'List Skills',
      description: 'Show the logical skill nodes and their JSON property blobs.',
      query: `PREFIX tgmeta: <urn:tg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn tgmeta:entityType "SKILL" ;
       tgmeta:properties ?props .
}
ORDER BY STR(?urn)`,
    },
    {
      title: 'List Skill Versions',
      description: 'Inspect published/draft versions and see active version metadata.',
      query: `PREFIX tgmeta: <urn:tg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn tgmeta:entityType "SKILL_VERSION" ;
       tgmeta:properties ?props .
}
ORDER BY STR(?urn)`,
    },
    {
      title: 'Artifact Linking Edges',
      description: 'See which agents or skill versions point at artifacts.',
      query: `PREFIX tgmeta: <urn:tg:meta:>

SELECT ?from ?predicate ?to
WHERE {
  ?edge tgmeta:from ?from ;
        tgmeta:to ?to ;
        tgmeta:predicate ?predicate .
  FILTER (?predicate IN ("tg:implementedBy", "tg:definedBy"))
}
ORDER BY STR(?from) STR(?to)`,
    },
  ];

  return renderPage(
    'Fuseki Query Shortcuts',
    `
      <p><a href="/">Back</a></p>
      <p>Use these copy-paste queries in Fuseki for the current metadata backend.</p>
      <p><strong>Fuseki UI:</strong> <a href="${escapeHtml(input.fusekiUrl)}">${escapeHtml(input.fusekiUrl)}</a> <small>(cluster-internal; reachable from inside the cluster, not a browser in production)</small></p>
      <p><strong>Dataset:</strong> <code>${escapeHtml(input.datasetName)}</code></p>
      <p><strong>Full query pack:</strong> <code>docs/fuseki-query-pack.md</code></p>
      ${queries
        .map(
          (item) => `
            <section class="panel">
              <h2>${escapeHtml(item.title)}</h2>
              <p>${escapeHtml(item.description)}</p>
              <pre>${escapeHtml(item.query)}</pre>
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
      <p><a href="/">Back</a></p>
      ${renderError(input.error)}
      ${suggestions}
      <p>Thin visual explorer for the current registry graph read model. This view is rooted and curated through <code>service/api</code>, not a raw browser-to-Fuseki integration.</p>
      <form method="get" action="/graph">
        ${renderTextInput('root_urn', 'Root URN', input.defaults.rootUrn, 'text', true)}
        ${renderTextInput('depth', 'Depth (1-5)', String(input.defaults.depth), 'number', true)}
        <button type="submit">Load graph</button>
      </form>
      <p><strong>Nodes:</strong> ${escapeHtml(String(input.graph.nodes.length))} | <strong>Edges:</strong> ${escapeHtml(String(input.graph.edges.length))}</p>
      <fieldset class="toolbar" id="graph-legend" aria-label="Filter node types">
        <label><input type="checkbox" data-node-type="AGENT" checked /> Agent</label>
        <label><input type="checkbox" data-node-type="SKILL" checked /> Skill</label>
        <label><input type="checkbox" data-node-type="SKILL_VERSION" checked /> Version</label>
        <label><input type="checkbox" data-node-type="ARTIFACT" checked /> Artifact</label>
        <label><input type="checkbox" data-node-type="HARNESS" checked /> Harness</label>
      </fieldset>
      <div class="graph-layout">
        <div id="graph-canvas" style="height: 520px; border: 1px solid var(--gray-200); background: #fff;"></div>
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
      <script>
        (function () {
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
                  'background-color': '#4a6cf7',
                  'label': 'data(label)',
                  'color': '#111',
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
                  'text-background-color': '#fff',
                  'text-background-opacity': 1,
                  'text-background-padding': 2,
                  'line-color': '#999',
                  'target-arrow-color': '#999',
                },
              },
              {
                selector: 'node[entityType = "AGENT"]',
                style: { 'background-color': '#3b82f6' },
              },
              {
                selector: 'node[entityType = "SKILL"]',
                style: { 'background-color': '#10b981' },
              },
              {
                selector: 'node[entityType = "SKILL_VERSION"]',
                style: { 'background-color': '#8b5cf6' },
              },
              {
                selector: 'node[entityType = "ARTIFACT"]',
                style: { 'background-color': '#f59e0b' },
              },
              {
                selector: 'node[entityType = "HARNESS"]',
                style: { 'background-color': '#ef4444' },
              },
            ],
          });
          const renderDetail = (urn) => {
            const node = nodeMap.get(urn);
            if (!node) return;
            const props = Object.entries(node.properties || {})
              .map(([key, value]) => '<tr><td>' + escapeHtmlHtml(key) + '</td><td>' + escapeHtmlHtml(stringifyValue(value)) + '</td></tr>')
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
                ? '<table><thead><tr><th>Property</th><th>Value</th></tr></thead><tbody>' + props + '</tbody></table>'
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
        }
      </script>
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
    <title>${escapeHtml(title)} · Cachet</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%234f46e5'/%3E%3Ctext x='8' y='12' font-size='10' text-anchor='middle' fill='white'%3EC%3C/text%3E%3C/svg%3E" />
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="app-header">
      <div class="container app-header-inner">
        <a class="brand" href="/">
          <span class="brand-logo" aria-hidden="true">C</span>
          <span class="brand-name">Cachet</span>
        </a>
        <nav class="app-nav" aria-label="Primary">
          ${navItem('/', 'Home', active, 'home')}
          ${navItem('/agents', 'Agents', active, 'agents')}
          ${navItem('/skills', 'Skills', active, 'skills')}
          ${navItem('/graph', 'Graph', active, 'graph')}
          ${navItem('/ontology-projects', 'Ontology', active, 'ontology')}
          ${navItem('/fuseki-queries', 'Fuseki', active, 'fuseki')}
        </nav>
        <div class="app-header-right">
          ${page?.session?.principalLabel ? `<p title="${escapeHtml(page.session.principalLabel)}">${escapeHtml(page.session.principalLabel)}</p>` : ''}
          ${
            page?.session?.authenticated
              ? `<form method="post" action="/session/logout"><input type="hidden" name="return_to" value="${escapeHtml(page.session.returnTo)}" /><button type="submit" class="secondary">Sign out</button></form>`
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
    <footer class="container app-footer"><small>Cachet registry · internal beta</small></footer>
    <script>
      // Client-side row filter for list pages (#table-filter + #filterable-table).
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
    </script>
  </body>
</html>`;
}

function renderStateBadge(state: string | undefined) {
  if (!state) return '';
  const key = String(state).toLowerCase().replace(/[^a-z_]/g, '');
  return `<span class="state-badge ${escapeHtml(key)}">${escapeHtml(String(state))}</span>`;
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
  const entries = Object.entries(properties).map(([key, value]) => [escapeHtml(key), escapeHtml(stringifyValue(value))]);
  return renderTable(['Property', 'Value'], entries);
}

function renderArtifactsTable(artifacts: Array<{ artifact_urn: string; sha256?: string }>) {
  return renderTable(
    ['Artifact URN', 'SHA256'],
    artifacts.map((artifact) => [escapeHtml(artifact.artifact_urn), escapeHtml(artifact.sha256 ?? '')]),
  );
}

function renderGraphNodeDetail(node: GraphSubgraph['nodes'][number]) {
  const detailHref = graphEntityDetailHref(node);
  return `
    <p><strong>Label:</strong> ${escapeHtml(node.label)}</p>
    <p><strong>Entity Type:</strong> ${escapeHtml(node.entity_type)}</p>
    <p><strong>URN:</strong> <code>${escapeHtml(node.urn)}</code></p>
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
        <section class="version-card">
          <h3>Version ${escapeHtml(String(versionNumber))} ${renderStateBadge(skillLifecycleStatus(version))}${isVersionActive(version) ? ' <span class="state-badge published">active</span>' : ''}</h3>
          ${renderSkillVersionSummary(version)}
          ${renderSkillVersionCard(version)}
          ${
            availableActions.length > 0
              ? renderLifecycleActionForm({
                  skillKey: input.skillKey,
                  versionNumber,
                  defaults: input.defaults,
                  actions: availableActions,
                })
              : '<p>No lifecycle actions available for this version.</p>'
          }
        </section>
      `;
    })
    .join('');
}

function renderSkillVersionCard(version: SkillVersionDetails) {
  return `
    <p><strong>Version URN:</strong> <code>${escapeHtml(version.skill_version.urn)}</code></p>
    ${renderPropertiesTable(version.skill_version.properties)}
    <h3>Artifacts</h3>
    ${renderArtifactsTable(version.artifacts)}
    <h3>Upstream Versions</h3>
    ${renderTable(
      ['Skill Version URN'],
      version.upstream_versions.map((upstream) => [escapeHtml(upstream.skill_version_urn)]),
    )}
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

  return `<ul class="summary-list">${tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join('')}</ul>`;
}

function renderLifecycleActionForm(input: {
  skillKey: string;
  versionNumber: number;
  defaults: SkillVersionOperationInput;
  actions: Array<'validate' | 'publish' | 'promote' | 'deprecate' | 'certify'>;
}) {
  return `
    <form method="post" action="/skills/${encodeURIComponent(input.skillKey)}/versions/${input.versionNumber}/${input.actions[0]}">
      ${renderTextInput('author', 'Author', input.defaults.author ?? '', 'text', true)}
      ${renderTextArea('note', 'Note', input.defaults.note ?? '')}
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
    session
      ? renderUnauthenticatedSessionPanel(session)
      : '<p>Sign in is not configured.</p>',
    input.page,
  );
}

function renderUnauthenticatedSessionPanel(input: PageChromeInput['session']) {
  if (input.authMode === 'api_key') {
    return `
      <p>Local API-key mode is enabled. Sign in with a bearer token minted by <code>service/api</code>. The webapp stores it server-side behind an HttpOnly cookie.</p>
      <form method="post" action="/session/login">
        <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
        ${renderTextInput('api_token', 'API bearer token', '', 'password', true)}
        <button type="submit">Start session</button>
      </form>
    `;
  }

  if (input.oktaMode === 'mock') {
    return `
      <p>Mock Okta mode is enabled. Start a simulated internal-user session over the same <code>service/api</code> auth boundary.</p>
      <form method="post" action="/session/login">
        <input type="hidden" name="return_to" value="${escapeHtml(input.returnTo)}" />
        <button type="submit">Start mock Okta session</button>
      </form>
    `;
  }

  return `
    <p>Use the internal Okta login path to acquire a browser session aligned to the <code>service/api</code> access-token flow.</p>
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

function lifecycleActions(version: SkillVersionDetails): Array<'validate' | 'publish' | 'promote' | 'deprecate' | 'certify'> {
  const status = skillLifecycleStatus(version);
  const active = isVersionActive(version);
  const certified = isVersionCertified(version);

  if (status === 'draft') return ['validate'];
  if (status === 'validated') return ['publish'];
  if (status === 'published') {
    const actions: Array<'validate' | 'publish' | 'promote' | 'deprecate' | 'certify'> = [];
    if (!active) actions.push('promote');
    actions.push('deprecate');
    if (!certified) actions.push('certify');
    return actions;
  }

  return [];
}

function lifecycleActionLabel(action: 'validate' | 'publish' | 'promote' | 'deprecate' | 'certify') {
  switch (action) {
    case 'validate':
      return 'Validate';
    case 'publish':
      return 'Publish';
    case 'promote':
      return 'Promote';
    case 'deprecate':
      return 'Deprecate';
    case 'certify':
      return 'Certify';
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
