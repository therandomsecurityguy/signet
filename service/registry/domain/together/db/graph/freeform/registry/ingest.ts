import { mkdir, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { ArtifactStore } from './artifact-store.js';
import type { GraphStore } from './graph-store.js';
import { agentUrn, artifactUrn, harnessUrn, skillUrn } from './urn.js';

export type RegistryIngestInput = {
  roots: Array<{ kind: 'agent' | 'skill'; dir: string }>;
  cas: ArtifactStore;
  graph: GraphStore;
};

export type RegistryIngestResult = {
  files_seen: number;
  entities_written: number;
  edges_written: number;
};

export async function ingestRegistry(input: RegistryIngestInput): Promise<RegistryIngestResult> {
  let files_seen = 0;
  let entities_written = 0;
  let edges_written = 0;

  for (const root of input.roots) {
    const absRoot = path.resolve(root.dir);
    const files = await listFilesRecursive(absRoot);

    for (const filePath of files) {
      files_seen += 1;

      const bytes = await readFile(filePath);
      const original_path = path.relative(absRoot, filePath);
      const media_type = inferMediaType(filePath);

      const artifact = await input.cas.put({
        bytes,
        ...(media_type ? { media_type } : {}),
        original_path: filePath,
      });
      const artifact_node_urn = artifactUrn(artifact.sha256);

      await input.graph.upsertNode({
        urn: artifact_node_urn,
        entity_type: 'ARTIFACT',
        properties: {
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          ...(artifact.media_type ? { media_type: artifact.media_type } : {}),
          original_path: artifact.original_path ?? original_path,
        },
      });
      entities_written += 1;

      if (root.kind === 'agent') {
        const rel = path.relative(absRoot, filePath);
        const { agent_key, harness_name } = agentKeyFromPath(rel);
        const agent_node_urn = agentUrn(agent_key);

        await input.graph.upsertNode({
          urn: agent_node_urn,
          entity_type: 'AGENT',
          properties: {
            agent_key,
            source_path: filePath,
            ...(harness_name ? { harness_name } : {}),
          },
        });
        entities_written += 1;

        await input.graph.upsertEdge({
          from_urn: agent_node_urn,
          to_urn: artifact_node_urn,
          predicate: 'sg:definedBy',
          properties: {},
        });
        edges_written += 1;

        if (harness_name) {
          const harness_node_urn = harnessUrn(harness_name);
          await input.graph.upsertNode({
            urn: harness_node_urn,
            entity_type: 'HARNESS',
            properties: { harness_name },
          });
          entities_written += 1;

          await input.graph.upsertEdge({
            from_urn: agent_node_urn,
            to_urn: harness_node_urn,
            predicate: 'sg:runsOn',
            properties: {},
          });
          edges_written += 1;
        }
      } else if (root.kind === 'skill') {
        if (path.basename(filePath) === 'AGENTS.md') {
          // Convention: AGENTS.md are guidance docs, not skill definitions.
          continue;
        }

        const rel = path.relative(absRoot, filePath);
        const skill_key = skillKeyFromPath(rel);
        const skill_node_urn = skillUrn(skill_key);

        await input.graph.upsertNode({
          urn: skill_node_urn,
          entity_type: 'SKILL',
          properties: {
            skill_key,
            source_path: filePath,
          },
        });
        entities_written += 1;

        await input.graph.upsertEdge({
          from_urn: skill_node_urn,
          to_urn: artifact_node_urn,
          predicate: 'sg:implementedBy',
          properties: {},
        });
        edges_written += 1;
      }
    }
  }

  return { files_seen, entities_written, edges_written };
}

function inferMediaType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.af') return 'text/plain';
  if (ext === '.json') return 'application/json';
  return undefined;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  await mkdir(dir, { recursive: true });

  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(p)));
    } else if (e.isFile()) {
      // Minimal include set for v1 ingestion.
      if (e.name === '.DS_Store') continue;
      out.push(p);
    }
  }
  return out;
}

function agentKeyFromPath(relPath: string): { agent_key: string; harness_name: string | null } {
  const normalized = relPath.split(path.sep).join('/');
  const parts = normalized.split('/').filter(Boolean);

  // Heuristic: last directory name is often the harness (cursor/claudecode/etc.).
  const dirParts = parts.slice(0, Math.max(0, parts.length - 1));
  const harness_name = dirParts.length > 0 ? dirParts[dirParts.length - 1] : null;
  const group = dirParts.length > 1 ? dirParts[0] : 'agent';

  if (harness_name) {
    return { agent_key: `${harness_name}:${group}`, harness_name };
  }
  return { agent_key: `agent:${normalized}`, harness_name: null };
}

function skillKeyFromPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join('/');
  return `skill:${normalized.replace(/\.[^.]+$/, '')}`;
}

