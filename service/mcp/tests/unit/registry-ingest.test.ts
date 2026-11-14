import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsCasArtifactStore } from '../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';
import { InMemoryGraphStore } from '../../../registry/domain/signet/db/graph/freeform/registry/graph-store.js';
import { ingestRegistry } from '../../../registry/domain/signet/db/graph/freeform/registry/ingest.js';
import { JsonFileGraphStore } from '../../../registry/domain/signet/db/graph/freeform/registry/json-file-graph-store.js';
import { agentUrn, skillUrn } from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

describe('registry ingestion', () => {
  it('ingests agent and skill files into CAS + graph', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-ingest-'));
    const agentsDir = path.join(tmp, 'agents');
    const skillsDir = path.join(tmp, 'skills');
    const objectsDir = path.join(tmp, 'objects');

    await mkdir(path.join(agentsDir, 'cyborg', 'cursor'), { recursive: true });
    await mkdir(skillsDir, { recursive: true });

    await writeFile(path.join(agentsDir, 'cyborg', 'cursor', 'AGENTS.md'), 'cursor agent');
    await writeFile(path.join(skillsDir, 'example-skill.md'), 'skill body');

    const cas = new FsCasArtifactStore(objectsDir);
    const graph = new InMemoryGraphStore();

    const res = await ingestRegistry({
      roots: [
        { kind: 'agent', dir: agentsDir },
        { kind: 'skill', dir: skillsDir },
      ],
      cas,
      graph,
    });

    expect(res.files_seen).toBe(2);
    expect(res.entities_written).toBeGreaterThan(0);
    expect(res.edges_written).toBeGreaterThan(0);

    const agent = await graph.getNode(agentUrn('cursor:cyborg'));
    expect(agent).not.toBeNull();

    const skill = await graph.getNode(skillUrn('skill:example-skill'));
    expect(skill).not.toBeNull();

    const definedBy = await graph.listEdgesFrom(agentUrn('cursor:cyborg'), 'sg:definedBy');
    expect(definedBy).toHaveLength(1);

    const skillImpl = await graph.listEdgesFrom(skillUrn('skill:example-skill'), 'sg:implementedBy');
    expect(skillImpl).toHaveLength(1);

    await rm(tmp, { recursive: true, force: true });
  });

  it('persists ingested graph state for repeatable bootstrap runs', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-ingest-persist-'));
    const agentsDir = path.join(tmp, 'agents');
    const objectsDir = path.join(tmp, 'objects');
    const stateFile = path.join(tmp, 'graph', 'registry-state.json');

    await mkdir(path.join(agentsDir, 'cyborg', 'cursor'), { recursive: true });
    await writeFile(path.join(agentsDir, 'cyborg', 'cursor', 'AGENTS.md'), 'cursor agent');

    const cas = new FsCasArtifactStore(objectsDir);
    const graph = new JsonFileGraphStore({ state_file: stateFile });

    await ingestRegistry({
      roots: [{ kind: 'agent', dir: agentsDir }],
      cas,
      graph,
    });

    const reopened = new JsonFileGraphStore({ state_file: stateFile });
    const persistedAgent = await reopened.getNode(agentUrn('cursor:cyborg'));
    const persistedEdges = await reopened.listEdgesFrom(agentUrn('cursor:cyborg'), 'sg:definedBy');

    expect(persistedAgent).not.toBeNull();
    expect(persistedEdges).toHaveLength(1);

    await rm(tmp, { recursive: true, force: true });
  });
});

