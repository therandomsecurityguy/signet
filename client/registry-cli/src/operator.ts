import { createHash, randomUUID, generateKeyPairSync, createPrivateKey, createPublicKey, sign as signBytes, type KeyObject } from 'node:crypto';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { z } from 'zod';

import { buildKeylessBundle } from './keyless.js';
import { DEFAULT_LOCK_FILE, parseLockTarget, readLockFile, serializeLockFile, upsertLockEntries, type LockEntry } from './lock.js';
import { artifactFileName, sourceFileBaseName, targetDirectory, type PullManifest } from './pull.js';
import { cfAccessHeaders, loadEnv, type Env } from './config/env.js';
import {
  AgentCreatePlan,
  AgentSeedSpecSchema,
  BootstrapManifestSchema,
  type BootstrapManifest,
  type AgentSeedSpec,
  type SkillSeedPlan,
  type SkillSeedSpec,
  type BootstrapProfile,
  type SkillSeedRef,
  SkillSeedSpecSchema,
} from './types.js';
import { HttpRegistryOperatorApiClient, RegistryOperatorApiError } from './clients/api.js';
import { RegistryOperatorMcpClient } from './clients/mcp.js';
import { sha256Hex, isTrustedKeyUsableAt, verifyEnvelopeSignatures, verifyProvenanceSignature } from './clients/verify.js';
import {
  buildTransparencySampleGraphSpec,
  readTransparencySampleGraphSpec,
  seedTransparencySampleGraph,
} from './transparency/sample-graph.js';

const AuthCreateApiKeyResultSchema = z.object({
  token: z.string().min(1),
  key_id: z.string().min(1),
  owner_label: z.string().min(1),
});

type AuthCreateApiKeyResult = z.infer<typeof AuthCreateApiKeyResultSchema>;

type GraphBackendPlaneConfig = {
  backend: string;
  sparql_query_url?: string;
  sparql_update_url?: string;
  sparql_username?: string;
  sparql_password?: string;
};

type CliCommand =
  | { group: 'local'; action: 'up' | 'down'; args: Record<string, string | boolean | string[] | undefined> }
  | { group: 'local'; action: 'reset'; args: Record<string, string | boolean | string[] | undefined> }
  | { group: 'auth'; action: 'create-api-key'; args: Record<string, string | boolean | string[] | undefined> }
  | {
      group: 'seed';
      action: 'skill' | 'agent' | 'bootstrap' | 'transparency-sample';
      args: Record<string, string | boolean | string[] | undefined>;
    }
  | {
      group: 'verify';
      action: 'api' | 'mcp' | 'okta-config' | 'browser-session' | 'publication' | 'artifact' | 'provenance' | 'report-signatures' | 'lock';
      args: Record<string, string | boolean | string[] | undefined>;
    }
  | { group: 'bootstrap'; action: 'test'; args: Record<string, string | boolean | string[] | undefined> }
  | { group: 'lock'; action: 'write'; args: Record<string, string | boolean | string[] | undefined> }
  | { group: 'pull'; action: 'run'; args: Record<string, string | boolean | string[] | undefined> }
  | { group: 'sign'; action: 'keyless'; args: Record<string, string | boolean | string[] | undefined> };

export type ResolveBootstrapOptions = {
  profile?: string;
  skillItemIds?: string[];
  agentItemIds?: string[];
};

export type ResolvedBootstrapManifest = {
  pack?: BootstrapManifest['pack'];
  profile?: string;
  signing?: { enabled: boolean; owner: string };
  skills: SkillSeedPlan[];
  agents: AgentCreatePlan[];
};

const DEFAULT_DEMO_MANIFEST_RELATIVE_PATH = path.join('client', 'registry-cli', 'examples', 'demo', 'demo.manifest.json');
const RUN_ARTIFACTS_RELATIVE_DIR = path.join('data', 'registry-operator');

export async function runCli(argv: string[]) {
  const env = loadEnv();
  const command = parseArgs(argv);
  applyCfAccessArgs(env, command.args);

  switch (command.group) {
    case 'local':
      if (command.action === 'up') return await runLocalUp(env);
      if (command.action === 'down') return await runLocalDown(env);
      return await runLocalReset(env, command.args);
    case 'auth':
      return await runCreateApiKey(env, command.args);
    case 'seed':
      if (command.action === 'skill') return await runSeedSkill(env, command.args);
      if (command.action === 'agent') return await runSeedAgent(env, command.args);
      if (command.action === 'transparency-sample') return await runSeedTransparencySample(env, command.args);
      return await runSeedBootstrap(env, command.args);
    case 'verify':
      if (command.action === 'api') return await runVerifyApi(env, command.args);
      if (command.action === 'mcp') return await runVerifyMcp(env, command.args);
      if (command.action === 'okta-config') return await runVerifyOktaConfig(env);
  if (command.action === 'publication') return await runVerifyPublication(env, command.args);
  if (command.action === 'artifact') return await runVerifyArtifact(env, command.args);
  if (command.action === 'provenance') return await runVerifyProvenance(env, command.args);
  if (command.action === 'report-signatures') return await runVerifyReportSignatures(env, command.args);
  if (command.action === 'lock') return await runVerifyLock(env, command.args);
      return await runVerifyBrowserSession(env, command.args);
    case 'lock':
      return await runLock(env, command.args);
    case 'pull':
      return await runPull(env, command.args);
    case 'bootstrap':
      return await runBootstrapTest(env, command.args);
    case 'sign':
      return await runSignKeyless(env, command.args);
  }
}

export function parseArgs(argv: string[]): CliCommand {
  const [group, maybeAction, ...rest] = argv;
  if (!group) {
    throw new Error('Usage: registry-operator <group> <action> [--options]');
  }
  // `pull` takes positional targets: options and targets mix freely.
  if (group === 'pull') {
    const { args, positionals } = parseOptionsWithPositionals(argv.slice(1));
    if (positionals.length > 0) args['_'] = positionals;
    return { group: 'pull', action: 'run', args };
  }
  // `lock` is a single-word command: every non-flag token is an option.
  if (!maybeAction || maybeAction.startsWith('--')) {
    if (group !== 'lock') {
      throw new Error('Usage: registry-operator <group> <action> [--options]');
    }
    return { group: 'lock', action: 'write', args: parseOptions(argv.slice(1)) };
  }
  const action = maybeAction;
  const args = parseOptions(rest);

  if (group === 'local' && (action === 'up' || action === 'down' || action === 'reset')) {
    return { group: 'local', action, args };
  }
  if (group === 'auth' && action === 'create-api-key') {
    return { group: 'auth', action, args };
  }
  if (group === 'seed' && (action === 'skill' || action === 'agent' || action === 'bootstrap' || action === 'transparency-sample')) {
    return { group: 'seed', action, args };
  }
  if (group === 'verify' && (action === 'api' || action === 'mcp' || action === 'okta-config' || action === 'browser-session' || action === 'publication' || action === 'artifact' || action === 'provenance' || action === 'report-signatures' || action === 'lock')) {
    return { group: 'verify', action, args };
  }
  if (group === 'bootstrap' && action === 'test') {
    return { group: 'bootstrap', action, args };
  }
  if (group === 'sign' && action === 'keyless') {
    return { group: 'sign', action, args };
  }

  throw new Error(`Unknown command: ${group} ${action}`);
}

export function buildSkillSeedPlan(spec: SkillSeedSpec, specDir: string): SkillSeedPlan {
  if (!spec.author) {
    throw new Error(`Skill ${spec.skill_key} is missing author after defaults resolution.`);
  }

  return {
    itemId: spec.item_id ?? spec.skill_key,
    dependsOn: spec.depends_on ?? [],
    tags: spec.tags ?? [],
    draft: {
      skill_key: spec.skill_key,
      author: spec.author,
      artifact_path: resolveSpecPath(specDir, spec.artifact_path),
      artifact_media_type: spec.artifact_media_type,
      ...(spec.display_name ? { display_name: spec.display_name } : {}),
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.source_path ? { source_path: spec.source_path } : { source_path: spec.artifact_path }),
      ...(spec.commit_sha ? { commit_sha: spec.commit_sha } : {}),
      ...(spec.git_tag ? { git_tag: spec.git_tag } : {}),
      ...(spec.artifact_signature ? { artifact_signature: spec.artifact_signature } : {}),
      ...(spec.capability_claims?.length ? { capability_claims: spec.capability_claims } : {}),
      ...(spec.lineage ? { lineage: spec.lineage } : {}),
    },
    ...(spec.validate_note ? { validateNote: spec.validate_note } : {}),
    ...(spec.publish_note ? { publishNote: spec.publish_note } : {}),
    certify: spec.certify,
    ...(spec.certify_note ? { certifyNote: spec.certify_note } : {}),
  };
}

export function buildAgentCreatePlan(spec: AgentSeedSpec, specDir: string): AgentCreatePlan {
  return {
    itemId: spec.item_id ?? spec.agent_key,
    dependsOn: spec.depends_on ?? [],
    tags: spec.tags ?? [],
    agent_key: spec.agent_key,
    ...(spec.harness_name ? { harness_name: spec.harness_name } : {}),
    ...(spec.display_name ? { display_name: spec.display_name } : {}),
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.source_path ? { source_path: spec.source_path } : spec.artifact_path ? { source_path: spec.artifact_path } : {}),
    ...(spec.artifact_path ? { artifact_path: resolveSpecPath(specDir, spec.artifact_path) } : {}),
    ...(spec.artifact_path ? { artifact_media_type: spec.artifact_media_type } : {}),
    skill_refs: spec.skill_refs.map((value) =>
      typeof value === 'string'
        ? value.startsWith('urn:')
          ? { skill_urn: value }
          : { skill_key: value }
        : {
            ...(value.skill_key ? { skill_key: value.skill_key } : {}),
            ...(value.skill_urn ? { skill_urn: value.skill_urn } : {}),
            ...(value.skill_item_id ? { skill_item_id: value.skill_item_id } : {}),
          },
    ),
  };
}

export function resolveBootstrapManifest(
  manifest: BootstrapManifest,
  manifestPath: string,
  options: ResolveBootstrapOptions = {},
): ResolvedBootstrapManifest {
  const specDir = path.dirname(manifestPath);
  const profile = options.profile ? resolveProfile(manifest, options.profile) : undefined;

  const rawSkills = manifest.skills.map((skill) => ({
    ...manifest.defaults?.skill,
    ...skill,
    item_id: skill.item_id ?? skill.skill_key,
    depends_on: skill.depends_on ?? [],
    tags: skill.tags ?? [],
  }));
  const rawAgents = manifest.agents.map((agent) => ({
    ...manifest.defaults?.agent,
    ...agent,
    item_id: agent.item_id ?? agent.agent_key,
    depends_on: agent.depends_on ?? [],
    tags: agent.tags ?? [],
  }));

  const selectedSkillIds = buildSelectionSet(rawSkills.map((item) => item.item_id), profile?.skill_item_ids, options.skillItemIds);
  const selectedAgentIds = buildSelectionSet(rawAgents.map((item) => item.item_id), profile?.agent_item_ids, options.agentItemIds);

  const selectedSkills = rawSkills.filter((skill) => selectedSkillIds.has(skill.item_id));
  const selectedAgents = rawAgents.filter((agent) => selectedAgentIds.has(agent.item_id));

  const selectedSkillMap = new Map(selectedSkills.map((skill) => [skill.item_id, skill]));
  const selectedAgentMap = new Map(selectedAgents.map((agent) => [agent.item_id, agent]));

  for (const skill of selectedSkills) {
    for (const dep of skill.depends_on) {
      if (!selectedSkillMap.has(dep)) {
        throw new Error(`Skill ${skill.item_id} depends on unknown or unselected skill item ${dep}.`);
      }
    }
  }

  const orderedSkills = topologicalOrder(selectedSkills, (item) => item.item_id, (item) => item.depends_on ?? [], 'skill');
  const builtSkills = orderedSkills.map((skill) => buildSkillSeedPlan(SkillSeedSpecSchema.parse(skill), specDir));
  const builtSkillMap = new Map(builtSkills.map((skill) => [skill.itemId, skill]));

  const resolvedAgents = selectedAgents.map((agent) => {
    for (const dep of agent.depends_on ?? []) {
      if (!selectedAgentMap.has(dep) && !selectedSkillMap.has(dep)) {
        throw new Error(`Agent ${agent.item_id} depends on unknown or unselected item ${dep}.`);
      }
    }

    const normalizedRefs = agent.skill_refs.map((ref) => normalizeSkillRef(ref, builtSkillMap));
    return buildAgentCreatePlan(
      AgentSeedSpecSchema.parse({
        ...agent,
        skill_refs: normalizedRefs,
      }),
      specDir,
    );
  });

  const orderedAgents = topologicalOrder(
    resolvedAgents,
    (item) => item.itemId,
    (item) => item.dependsOn.filter((dep) => selectedAgentMap.has(dep)),
    'agent',
  );

  return {
    ...(manifest.pack ? { pack: manifest.pack } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(manifest.signing ? { signing: manifest.signing } : {}),
    skills: builtSkills,
    agents: orderedAgents,
  };
}

export function assertResetAllowed(args: Record<string, string | boolean | string[] | undefined>) {
  if (!args.force) {
    throw new Error('Refusing to reset local state without --force.');
  }
}

async function runLocalUp(env: Env) {
  await runShell('make', ['up'], { cwd: path.join(env.REPO_ROOT, 'infra') });
  console.log('Local stack started.');
}

async function runLocalDown(env: Env) {
  await runShell('make', ['down'], { cwd: path.join(env.REPO_ROOT, 'infra') });
  console.log('Local stack stopped.');
}

async function runLocalReset(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  assertResetAllowed(args);
  await clearSparqlDatasetsForReset(env);
  await runLocalDown(env).catch(() => undefined);

  const targets = [
    path.join(env.REPO_ROOT, 'data', 'api'),
    path.join(env.REPO_ROOT, 'data', 'mcp'),
    path.join(env.REPO_ROOT, 'data', 'registry-operator'),
    path.join(env.REPO_ROOT, 'data', 'webapp'),
    path.join(env.REPO_ROOT, 'data', 'registry', 'graph'),
    path.join(env.REPO_ROOT, 'data', 'registry', 'objects'),
    path.join(env.REPO_ROOT, '.cookies'),
  ];
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
  }
  console.log('Local bind-mounted state cleared.');
}

async function runCreateApiKey(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const plane = asString(args.plane) ?? 'api';
  const ownerLabel = asString(args['owner-label']) ?? 'Registry Operator';
  const result = await createApiKey(env, plane === 'mcp' ? 'mcp' : 'api', ownerLabel);
  console.log(JSON.stringify(result, null, 2));
}

async function runSeedSkill(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  await waitForApiAndGraphReadiness(env);
  const specPath = requireStringArg(args, 'spec');
  const apiToken = requireStringArg(args, 'api-token');
  const spec = SkillSeedSpecSchema.parse(JSON.parse(await readFile(specPath, 'utf8')));
  const plan = buildSkillSeedPlan(spec, path.dirname(specPath));
  if (args['dry-run']) {
    console.log(JSON.stringify({ plan }, null, 2));
    return;
  }
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const drafted = await api.createSkillDraft(plan, apiToken);
  await api.validateSkillVersion(
    {
      skill_key: plan.draft.skill_key,
      version: drafted.version,
      author: plan.draft.author,
      ...(plan.validateNote ? { note: plan.validateNote } : {}),
    },
    apiToken,
  );
  await api.publishSkillVersion(
    {
      skill_key: plan.draft.skill_key,
      version: drafted.version,
      author: plan.draft.author,
      ...(plan.publishNote ? { note: plan.publishNote } : {}),
    },
    apiToken,
  );
  if (plan.certify) {
    await api.certifySkillVersion(
      {
        skill_key: plan.draft.skill_key,
        version: drafted.version,
        author: plan.draft.author,
        ...(plan.certifyNote ? { note: plan.certifyNote } : {}),
      },
      apiToken,
    );
  }
  const active = await api.getActiveSkillVersion(plan.draft.skill_key, apiToken);
  console.log(
    JSON.stringify(
      {
        skill_key: plan.draft.skill_key,
        version: drafted.version,
        active,
      },
      null,
      2,
    ),
  );
}

async function runSeedAgent(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  await waitForApiAndGraphReadiness(env);
  const specPath = requireStringArg(args, 'spec');
  const apiToken = requireStringArg(args, 'api-token');
  const spec = AgentSeedSpecSchema.parse(JSON.parse(await readFile(specPath, 'utf8')));
  const plan = buildAgentCreatePlan(spec, path.dirname(specPath));
  if (args['dry-run']) {
    console.log(JSON.stringify({ plan }, null, 2));
    return;
  }
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const created = await api.createAgent(plan, apiToken);
  console.log(JSON.stringify(created, null, 2));
}

async function runSeedBootstrap(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  await waitForApiAndGraphReadiness(env);
  const manifestPath = resolveManifestPath(env, asString(args.manifest));
  const apiToken = requireStringArg(args, 'api-token');
  const manifest = await readBootstrapManifest(manifestPath);
  const resolved = resolveBootstrapManifest(manifest, manifestPath, {
    profile: asString(args.profile),
    skillItemIds: toStringArray(args['skill-item-id']),
    agentItemIds: toStringArray(args['agent-item-id']),
  });
  if (args['dry-run']) {
    console.log(JSON.stringify({ ok: true, resolved }, null, 2));
    return;
  }
  await seedResolvedBootstrapManifest(env, resolved, apiToken);
  console.log(JSON.stringify({ ok: true, manifest: manifestPath, resolved }, null, 2));
}

async function runSeedTransparencySample(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const dryRun = Boolean(args['dry-run']);
  const specPath = asString(args.spec);
  const sampleSlug = asString(args['sample-slug']);
  const day = asString(args.day);
  const humanProofReport = Boolean(args['human-proof-report']);
  if (specPath && (sampleSlug || day)) {
    throw new Error('Use either --spec or --sample-slug/--day for transparency-sample, not both.');
  }

  const spec = specPath
    ? await readTransparencySampleGraphSpec(path.resolve(specPath))
    : buildTransparencySampleGraphSpec({
        ...(sampleSlug ? { sampleSlug } : {}),
        ...(day ? { day } : {}),
      });

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, spec }, null, 2));
    return;
  }

  await waitForApiAndGraphReadiness(env);
  const apiToken = requireStringArg(args, 'api-token');
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const seeded = await seedTransparencySampleGraph(api, apiToken, { spec });
  const log = await api.getTransparencyLog(seeded.spec.logId, apiToken);
  const verification = await api.getTransparencyLogVerification(seeded.spec.logId, apiToken);
  const timeline = await api.getTransparencyLogTimeline(seeded.spec.logId, apiToken);
  if (humanProofReport) {
    console.log(
      JSON.stringify(
        buildTransparencyHumanProofReport({
          apiOrigin: env.API_ORIGIN,
          seeded,
          log,
          verification,
          timeline,
        }),
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        sample: seeded,
        log,
        verification,
        timeline,
      },
      null,
      2,
    ),
  );
}

function buildTransparencyHumanProofReport(input: {
  apiOrigin: string;
  seeded: Awaited<ReturnType<typeof seedTransparencySampleGraph>>;
  log: Record<string, unknown>;
  verification: Record<string, unknown>;
  timeline: Record<string, unknown>;
}) {
  const verificationStatus = readStringField(input.verification, 'verification_status');
  const checkpointSignatureValid = readBooleanField(input.verification, 'checkpoint_signature_valid');
  const checkpointConsistencyVerified = readBooleanField(input.verification, 'checkpoint_consistency_verified');
  const witnessQuorumMet = readBooleanField(input.verification, 'witness_quorum_met');
  const witnessQuorumRequired = readNumberField(input.verification, 'witness_quorum_required');
  const checkpointHistory = readArrayField(input.verification, 'checkpoint_history');
  const observations = readArrayField(input.verification, 'observations');
  const disagreements = readArrayField(input.verification, 'disagreements');
  const gossipEvents = readArrayField(input.verification, 'gossip_events');
  const timelineEvents = readArrayField(input.timeline, 'events');
  const currentCheckpoint = readObjectField(input.log, 'current_checkpoint');

  return {
    ok: true,
    report_type: 'human-proof-report',
    sample_id: input.seeded.spec.sampleSlug,
    log_id: input.seeded.spec.logId,
    trust_verdict: {
      verification_status: verificationStatus,
      checkpoint_signature_valid: checkpointSignatureValid,
      checkpoint_consistency_verified: checkpointConsistencyVerified,
      witness_quorum_met: witnessQuorumMet,
      witness_quorum_required: witnessQuorumRequired,
    },
    current_checkpoint: {
      tree_size: readNumberField(currentCheckpoint, 'tree_size'),
      root_hash: readStringField(currentCheckpoint, 'root_hash'),
      note_format: readStringField(currentCheckpoint, 'note_format'),
      signature_count: readNumberField(currentCheckpoint, 'signature_count'),
    },
    network_evidence: {
      checkpoint_history_count: checkpointHistory.length,
      observation_count: observations.length,
      disagreement_count: disagreements.length,
      disagreement_kinds: [...new Set(disagreements.map((item) => readStringField(item, 'kind')).filter(Boolean))],
      gossip_event_count: gossipEvents.length,
      timeline_event_count: timelineEvents.length,
    },
    payload_proofs: {
      primary_checkpoint_payload_sha256: input.seeded.checkpointTwoPayloadSha,
      conflicting_observation_payload_sha256: input.seeded.checkpointTwoAltPayloadSha,
    },
    inspect_urls: {
      log: `${input.apiOrigin}/v1/transparency-logs/${encodeURIComponent(input.seeded.spec.logId)}`,
      verification: `${input.apiOrigin}/v1/transparency-logs/${encodeURIComponent(input.seeded.spec.logId)}/verification`,
      timeline: `${input.apiOrigin}/v1/transparency-logs/${encodeURIComponent(input.seeded.spec.logId)}/timeline`,
    },
    what_to_look_for: [
      'Current checkpoint should have a valid signature and append-only growth.',
      'Witness quorum should be met for the later checkpoint.',
      'Disagreement kinds show the intentionally conflicting network observations.',
      'Payload SHA256 values let humans compare the trusted and conflicting sample notes.',
    ],
  };
}

async function runVerifyApi(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  await waitForApiAndGraphReadiness(env);
  const manifestPath = resolveManifestPath(env, asString(args.manifest));
  const apiToken = requireStringArg(args, 'api-token');
  const manifest = await readBootstrapManifest(manifestPath);
  const resolved = resolveBootstrapManifest(manifest, manifestPath, {
    profile: asString(args.profile),
    skillItemIds: toStringArray(args['skill-item-id']),
    agentItemIds: toStringArray(args['agent-item-id']),
  });
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });

  const skills = [];
  for (const skill of resolved.skills) {
    const value = await api.getActiveSkillVersion(skill.draft.skill_key, apiToken);
    skills.push({ item_id: skill.itemId, skill_key: skill.draft.skill_key, active: value });
  }
  const agents = [];
  for (const agent of resolved.agents) {
    const value = await api.getAgent(agent.agent_key, apiToken);
    agents.push({ item_id: agent.itemId, agent_key: agent.agent_key, agent: value });
  }

  console.log(JSON.stringify({ skills, agents }, null, 2));
}

async function runVerifyMcp(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  await waitForMcpAndGraphReadiness(env);
  const manifestPath = resolveManifestPath(env, asString(args.manifest));
  const mcpToken = requireStringArg(args, 'mcp-token');
  const manifest = await readBootstrapManifest(manifestPath);
  const resolved = resolveBootstrapManifest(manifest, manifestPath, {
    profile: asString(args.profile),
    skillItemIds: toStringArray(args['skill-item-id']),
    agentItemIds: toStringArray(args['agent-item-id']),
  });
  const mcp = new RegistryOperatorMcpClient({ mcpOrigin: env.MCP_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const result = await mcp.verifyBootstrap({
    token: mcpToken,
    agentKeys: resolved.agents.map((agent) => agent.agent_key),
    skillKeys: resolved.skills.map((skill) => skill.draft.skill_key),
  });
  console.log(JSON.stringify(result, null, 2));
}

// Verify a published version before loading it: server verdicts plus
// independent client-side checks (canonical digest recomputation and detached
// signature verification against trusted keys fetched from the registry).
// Non-strict mode passes for a publication with no signatures (vacuous
// validity); --strict additionally requires the server verdict, at least one
// valid signature, and a matching frozen-envelope artifact when present.
/**
 * Resolve trusted signing keys to their PEMs (stored as CAS artifacts),
 * mirroring the registry's resolver: the key must be `trusted` and inside
 * its validity window before its PEM is used. Revoked/expired/not-yet-valid
 * keys stay absent so local verdicts match the server's
 * `trusted_public_key_resolved` semantics (a revoked key's signatures must
 * read as invalid, not verified).
 */
async function loadTrustedPublicKeyPems(
  api: HttpRegistryOperatorApiClient,
  keyRefs: Iterable<string>,
  apiToken: string | undefined,
): Promise<Map<string, string>> {
  const publicKeys = new Map<string, string>();
  const now = new Date().toISOString();
  for (const keyRef of new Set(keyRefs)) {
    if (!keyRef) continue;
    try {
      const key = await api.getPublicKey(keyRef, apiToken);
      const publicKey = key['public_key'] as { properties?: Record<string, unknown> } | undefined;
      const properties = publicKey?.properties;
      if (!properties || !isTrustedKeyUsableAt(properties, now)) continue;
      const artifacts = Array.isArray(key['artifacts']) ? (key['artifacts'] as Array<{ artifact_urn?: string }>) : [];
      const sha = parseArtifactUrnSha256(artifacts[0]?.artifact_urn);
      if (!sha) continue;
      const { bytes } = await api.getArtifactBytes(sha, apiToken);
      publicKeys.set(keyRef, new TextDecoder().decode(bytes));
    } catch {
      // Unresolvable or untrusted keys stay absent; their signatures fail verification.
    }
  }
  return publicKeys;
}

async function runVerifyPublication(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const skillKey = asString(args.skill);
  const agentKey = asString(args.agent);
  const version = Number(asString(args.version));
  const strict = args.strict === true;
  const apiToken = asString(args['api-token']);
  if ((!skillKey && !agentKey) || (skillKey && agentKey) || !Number.isInteger(version) || version <= 0) {
    throw new Error(
      'Usage: registry-operator verify publication (--skill <key> | --agent <key>) --version <n> [--strict] [--api-token <token>]',
    );
  }

  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const envelope = skillKey
    ? await api.getSkillPublicationEnvelope(skillKey, version, apiToken)
    : await api.getAgentPublicationEnvelope(agentKey as string, version, apiToken);
  const serverVerification = skillKey
    ? await api.getSkillPublicationVerification(skillKey, version, apiToken)
    : await api.getAgentPublicationVerification(agentKey as string, version, apiToken);

  const signatures = Array.isArray(envelope['detached_signatures'])
    ? (envelope['detached_signatures'] as Array<{
        artifact_urn?: string;
        key_ref?: string;
        algorithm?: string;
        signed_payload?: 'canonical_json' | 'canonical_rdf';
        envelope_sha256?: string;
        signature?: string;
        keyless?: { identity?: string; issuer?: string };
      }>)
    : [];

  // Resolve every trusted signing key to its PEM, enforcing the same trust
  // status + validity window as the registry. Keyless signatures carry no
  // registered key: their trust policy lives with the registry, so their
  // verdict is taken from the server verification.
  const publicKeys = await loadTrustedPublicKeyPems(
    api,
    signatures
      .filter((signature) => !signature.keyless)
      .map((signature) => signature.key_ref)
      .filter((keyRef): keyRef is string => Boolean(keyRef)),
    apiToken,
  );

  const clientVerdict = verifyEnvelopeSignatures({
    envelope: {
      canonical_json: String(envelope['canonical_json'] ?? ''),
      canonical_json_sha256: String(envelope['canonical_json_sha256'] ?? ''),
      detached_signatures: signatures.map((signature) => ({
        key_ref: signature.key_ref ?? '',
        algorithm: signature.algorithm ?? '',
        ...(signature.signed_payload ? { signed_payload: signature.signed_payload } : {}),
        envelope_sha256: signature.envelope_sha256 ?? '',
        signature: signature.signature ?? '',
      })),
    },
    resolvePublicKey: (keyRef) => publicKeys.get(keyRef),
  });

  const serverChecks = Array.isArray(serverVerification['signature_checks'])
    ? (serverVerification['signature_checks'] as Array<{
        artifact_urn?: string;
        key_ref?: string;
        signature_kind?: string;
        keyless?: {
          identity?: string;
          issuer?: string;
          verified?: boolean;
          failure_kind?: string;
          error?: string;
          validity_evaluated_at?: string;
          tlog?: {
            present: boolean;
            verified: boolean;
            body_bound: boolean;
            integrated_time_verified?: boolean;
            log_index?: number;
            integrated_time?: string;
            failure_kind?: string;
            error?: string;
          };
        };
      }>)
    : [];
  const serverCheckByArtifact = new Map(
    serverChecks.map((check) => [check.artifact_urn ?? '', check]),
  );

  // Merge client-side verdicts (trusted keys) with server-derived keyless
  // verdicts. The helper maps signatures 1:1, so index alignment holds.
  const combinedSignatures = signatures.map((signature, index) => {
    if (signature.keyless) {
      const signedPayload = signature.signed_payload ?? 'canonical_json';
      const expectedDigest =
        signedPayload === 'canonical_rdf'
          ? (typeof envelope['canonical_rdf_sha256'] === 'string'
              ? (envelope['canonical_rdf_sha256'] as string)
              : undefined)
          : String(envelope['canonical_json_sha256'] ?? '');
      const digestMatches =
        expectedDigest !== undefined && expectedDigest.length > 0 && signature.envelope_sha256 === expectedDigest;
      const serverCheck =
        serverCheckByArtifact.get(signature.artifact_urn ?? '') ??
        serverChecks.find((check) => check.key_ref === signature.key_ref);
      const keylessVerified = serverCheck?.keyless?.verified === true;
      return {
        key_ref: signature.key_ref ?? '',
        algorithm: signature.algorithm ?? '',
        signed_payload: signedPayload,
        digest_matches: digestMatches,
        signature_valid: digestMatches && keylessVerified,
        signature_kind: 'keyless' as const,
        keyless: {
          identity: serverCheck?.keyless?.identity ?? signature.keyless.identity ?? '',
          issuer: serverCheck?.keyless?.issuer ?? signature.keyless.issuer ?? '',
          verified: keylessVerified,
          ...(serverCheck?.keyless?.failure_kind ? { failure_kind: serverCheck.keyless.failure_kind } : {}),
          ...(serverCheck?.keyless?.error ? { error: serverCheck.keyless.error } : {}),
          ...(serverCheck?.keyless?.validity_evaluated_at
            ? { validity_evaluated_at: serverCheck.keyless.validity_evaluated_at }
            : {}),
          ...(serverCheck?.keyless?.tlog ? { tlog: serverCheck.keyless.tlog } : {}),
        },
      };
    }
    return { ...clientVerdict.signatures[index], signature_kind: 'trusted_key' as const };
  });
  const allSignaturesValid = combinedSignatures.every((signature) => signature.signature_valid);
  const serverStatus = String(serverVerification['verification_status'] ?? 'unknown');
  const validSignatures = combinedSignatures.filter((signature) => signature.signature_valid).length;
  const frozenPresent = serverVerification['publication_envelope_artifact_present'] === true;
  const strictFailures: string[] = [];
  if (strict) {
    if (serverStatus !== 'verified') strictFailures.push(`server verification_status is ${serverStatus}`);
    if (validSignatures === 0) strictFailures.push('no valid detached signature');
    if (frozenPresent && serverVerification['publication_envelope_artifact_sha256_matches'] === false) {
      strictFailures.push('frozen envelope artifact digest mismatch');
    }
  }
  const verified =
    clientVerdict.canonical_json_sha256_matches && allSignaturesValid && strictFailures.length === 0;

  console.log(
    JSON.stringify(
      {
        publication_urn: envelope['publication_urn'] ?? null,
        strict,
        server: {
          verification_status: serverStatus,
          transparency_verification_status: serverVerification['transparency_verification_status'] ?? null,
          publication_envelope_artifact_present: frozenPresent,
          publication_envelope_artifact_sha256_matches:
            serverVerification['publication_envelope_artifact_sha256_matches'] ?? null,
          live_envelope_matches_frozen_artifact:
            serverVerification['live_envelope_matches_frozen_artifact'] ?? null,
        },
        client: {
          canonical_json_sha256_matches: clientVerdict.canonical_json_sha256_matches,
          all_signatures_valid: allSignaturesValid,
          signatures: combinedSignatures,
        },
        valid_signatures: validSignatures,
        strict_failures: strictFailures,
        verdict: verified ? 'verified' : 'unverified',
      },
      null,
      2,
    ),
  );

  if (!verified) {
    throw new Error('Publication did not verify.');
  }
}

async function runVerifyProvenance(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const skillKey = asString(args.skill);
  const agentKey = asString(args.agent);
  const version = Number(asString(args.version));
  const strict = args.strict === true;
  const apiToken = asString(args['api-token']);
  if ((!skillKey && !agentKey) || (skillKey && agentKey) || !Number.isInteger(version) || version <= 0) {
    throw new Error(
      'Usage: registry-operator verify provenance (--skill <key> | --agent <key>) --version <n> [--strict] [--api-token <token>]',
    );
  }

  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const provenance = skillKey
    ? await api.getSkillProvenance(skillKey, version, apiToken)
    : await api.getAgentProvenance(agentKey as string, version, apiToken);

  const evidence = provenance['evidence'] as
    | { canonical_rdf_sha256?: string; canonical_rdf_artifact_urn?: string }
    | undefined;
  const currentSha = typeof evidence?.canonical_rdf_sha256 === 'string' ? evidence.canonical_rdf_sha256 : undefined;
  if (!currentSha) {
    throw new Error('Provenance response did not include the canonical export evidence.');
  }

  // Transport integrity: fetch the canonical artifact at its digest and
  // recompute the hash locally.
  const { bytes: currentBytes } = await api.getArtifactBytes(currentSha, apiToken);
  const transportDigestMatches = sha256Hex(currentBytes) === currentSha;

  const servedSignatures = Array.isArray(provenance['provenance_signatures'])
    ? (provenance['provenance_signatures'] as Array<{
        artifact_urn?: string;
        key_ref?: string;
        algorithm?: string;
        provenance_sha256?: string;
        artifact_present?: boolean;
      }>)
    : [];

  // Resolve every trusted signing key to its PEM, enforcing the same trust
  // status + validity window as the registry.
  const publicKeys = await loadTrustedPublicKeyPems(
    api,
    servedSignatures.map((row) => row.key_ref).filter((keyRef): keyRef is string => Boolean(keyRef)),
    apiToken,
  );

  // Reproduce each verdict locally: fetch the stored signature record, the
  // canonical artifact it binds, and check the crypto against the key.
  const signatures = [];
  for (const row of servedSignatures) {
    const recordSha = parseArtifactUrnSha256(row.artifact_urn);
    let record: Record<string, unknown> | null = null;
    try {
      if (recordSha) {
        const { bytes } = await api.getArtifactBytes(recordSha, apiToken);
        record = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      }
    } catch {
      // Missing/unreadable signature record: the signature fails verification.
    }
    const key_ref = typeof record?.['key_ref'] === 'string' ? record['key_ref'] : (row.key_ref ?? '');
    const algorithm = typeof record?.['algorithm'] === 'string' ? record['algorithm'] : (row.algorithm ?? '');
    const provenance_sha256 =
      typeof record?.['provenance_sha256'] === 'string' ? record['provenance_sha256'] : (row.provenance_sha256 ?? '');
    const signature = typeof record?.['signature'] === 'string' ? record['signature'] : undefined;
    if (!signature || !provenance_sha256) {
      signatures.push({ key_ref, algorithm, provenance_sha256, digest_matches: false, signature_valid: false, verdict: 'invalid' as const });
      continue;
    }
    let signedBytes: Uint8Array | null = null;
    try {
      const { bytes } = await api.getArtifactBytes(provenance_sha256, apiToken);
      signedBytes = bytes;
    } catch {
      // Missing/unreadable signed artifact: the signature fails verification.
    }
    if (!signedBytes) {
      signatures.push({ key_ref, algorithm, provenance_sha256, digest_matches: false, signature_valid: false, verdict: 'invalid' as const });
      continue;
    }
    signatures.push(
      verifyProvenanceSignature({
        canonicalRdfBytes: signedBytes,
        currentProvenanceSha256: currentSha,
        signature: { key_ref, algorithm, provenance_sha256, signature },
        resolvePublicKey: (ref) => publicKeys.get(ref),
      }),
    );
  }

  const validSignatures = signatures.filter((check) => check.verdict === 'valid').length;
  const staleSignatures = signatures.filter((check) => check.verdict === 'stale').length;
  const invalidSignatures = signatures.filter((check) => check.verdict === 'invalid').length;

  const strictFailures = strict && validSignatures === 0 ? ['no current provenance signature'] : [];
  const verified = transportDigestMatches && invalidSignatures === 0 && strictFailures.length === 0;

  console.log(
    JSON.stringify(
      {
        entity: provenance['entity'] ?? null,
        strict,
        current_provenance_sha256: currentSha,
        transport_digest_matches: transportDigestMatches,
        signatures,
        valid_signatures: validSignatures,
        stale_signatures: staleSignatures,
        invalid_signatures: invalidSignatures,
        strict_failures: strictFailures,
        verdict: verified ? 'verified' : 'unverified',
      },
      null,
      2,
    ),
  );

  if (!verified) {
    throw new Error('Provenance did not verify.');
  }
}

async function runVerifyReportSignatures(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const skillKey = asString(args.skill);
  const agentKey = asString(args.agent);
  const version = Number(asString(args.version));
  const strict = args.strict === true;
  const apiToken = asString(args['api-token']);
  if ((!skillKey && !agentKey) || (skillKey && agentKey) || !Number.isInteger(version) || version <= 0) {
    throw new Error(
      'Usage: registry-operator verify report-signatures (--skill <key> | --agent <key>) --version <n> [--strict] [--api-token <token>]',
    );
  }

  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const served = skillKey
    ? await api.getSkillReportSignatures(skillKey, version, apiToken)
    : await api.getAgentReportSignatures(agentKey as string, version, apiToken);
  const rows = Array.isArray(served['report_signatures'])
    ? (served['report_signatures'] as Array<{
        artifact_urn?: string;
        key_ref?: string;
        algorithm?: string;
        report_artifact_urn?: string;
        report_canonical_rdf_sha256?: string;
      }>)
    : [];

  // Resolve every trusted signing key to its PEM, enforcing the same trust
  // status + validity window as the registry.
  const publicKeys = await loadTrustedPublicKeyPems(
    api,
    rows.map((row) => row.key_ref).filter((keyRef): keyRef is string => Boolean(keyRef)),
    apiToken,
  );

  // Reproduce each verdict locally: the stored signature record, the target
  // report (must still declare the signed digest), and the canonical RDF
  // artifact the signature binds.
  const signatures = [];
  for (const row of rows) {
    const recordSha = parseArtifactUrnSha256(row.artifact_urn);
    let record: Record<string, unknown> | null = null;
    try {
      if (recordSha) {
        const { bytes } = await api.getArtifactBytes(recordSha, apiToken);
        record = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      }
    } catch {
      // Missing/unreadable signature record: the row fails verification.
    }
    const key_ref = typeof record?.['key_ref'] === 'string' ? record['key_ref'] : (row.key_ref ?? '');
    const algorithm = typeof record?.['algorithm'] === 'string' ? record['algorithm'] : (row.algorithm ?? '');
    const report_artifact_urn =
      typeof record?.['report_artifact_urn'] === 'string' ? record['report_artifact_urn'] : (row.report_artifact_urn ?? '');
    const report_canonical_rdf_sha256 =
      typeof record?.['report_canonical_rdf_sha256'] === 'string'
        ? record['report_canonical_rdf_sha256']
        : (row.report_canonical_rdf_sha256 ?? '');
    const signature = typeof record?.['signature'] === 'string' ? record['signature'] : undefined;

    const failRow = {
      key_ref,
      algorithm,
      report_artifact_present: false,
      digest_matches: false,
      signature_valid: false,
      verdict: 'invalid' as const,
    };
    if (!signature || !report_canonical_rdf_sha256) {
      signatures.push(failRow);
      continue;
    }

    const reportSha = parseArtifactUrnSha256(report_artifact_urn);
    let report_artifact_present = false;
    try {
      if (reportSha) {
        const { bytes } = await api.getArtifactBytes(reportSha, apiToken);
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
          payload?: { rdf?: { canonical_rdf_sha256?: string } };
        };
        report_artifact_present = parsed.payload?.rdf?.canonical_rdf_sha256 === report_canonical_rdf_sha256;
      }
    } catch {
      report_artifact_present = false;
    }

    let signedBytes: Uint8Array | null = null;
    try {
      const { bytes } = await api.getArtifactBytes(report_canonical_rdf_sha256, apiToken);
      signedBytes = bytes;
    } catch {
      // Missing/unreadable canonical artifact: the signature fails verification.
    }

    if (!signedBytes) {
      signatures.push({ ...failRow, report_artifact_present });
      continue;
    }
    const check = verifyProvenanceSignature({
      canonicalRdfBytes: signedBytes,
      signature: { key_ref, algorithm, provenance_sha256: report_canonical_rdf_sha256, signature },
      resolvePublicKey: (ref) => publicKeys.get(ref),
    });
    signatures.push({
      key_ref: check.key_ref,
      algorithm: check.algorithm,
      report_artifact_present,
      digest_matches: check.digest_matches,
      signature_valid: check.signature_valid,
      verdict: report_artifact_present && check.verdict === 'valid' ? ('valid' as const) : ('invalid' as const),
    });
  }

  const validSignatures = signatures.filter((check) => check.verdict === 'valid').length;
  const invalidSignatures = signatures.filter((check) => check.verdict === 'invalid').length;

  const strictFailures = strict && validSignatures === 0 ? ['no valid report signature'] : [];
  const verified = invalidSignatures === 0 && strictFailures.length === 0;

  console.log(
    JSON.stringify(
      {
        strict,
        report_signatures: signatures,
        valid_signatures: validSignatures,
        invalid_signatures: invalidSignatures,
        strict_failures: strictFailures,
        verdict: verified ? 'verified' : 'unverified',
      },
      null,
      2,
    ),
  );

  if (!verified) {
    throw new Error('Report signatures did not verify.');
  }
}

async function runLock(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const skillTargets = asStringArray(args.skill);
  const agentTargets = asStringArray(args.agent);
  if (skillTargets.length === 0 && agentTargets.length === 0) {
    throw new Error(
      'Usage: registry-operator lock (--skill <key>[@<version>] | --agent <key>[@<version>]) [--lock-file <path>]',
    );
  }
  const lockPath = path.resolve(asString(args['lock-file']) ?? DEFAULT_LOCK_FILE);
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });

  const targets = [
    ...skillTargets.map((raw) => ({ raw, expected: 'skill' as const })),
    ...agentTargets.map((raw) => ({ raw, expected: 'agent' as const })),
  ];
  const entries: LockEntry[] = [];
  for (const { raw, expected } of targets) {
    const target = parseLockTarget(raw);
    if (target.type !== expected) {
      throw new Error(`Invalid lock target "${raw}": expected a ${expected} key.`);
    }
    entries.push(await resolveLockTarget(api, target));
  }

  const existing = await readLockFile(lockPath);
  const updated = upsertLockEntries(existing, entries, new Date().toISOString());
  await writeFile(lockPath, serializeLockFile(updated), 'utf8');

  console.log(
    JSON.stringify(
      {
        lock_file: lockPath,
        updated: entries.map((entry) => ({
          type: entry.type,
          key: entry.key,
          version: entry.version,
          envelope_sha256: entry.envelope_sha256,
        })),
        entries: updated.entries.length,
      },
      null,
      2,
    ),
  );
}

async function resolveLockTarget(
  api: HttpRegistryOperatorApiClient,
  target: { type: 'skill' | 'agent'; key: string; version?: number },
): Promise<LockEntry> {
  let version = target.version;
  if (!version) {
    const active =
      target.type === 'skill'
        ? await api.getActiveSkillVersion(target.key)
        : await api.getActiveAgentVersion(target.key);
    const activeVersion = Number(versionPropsOf(active, target.type)?.['version']);
    if (!Number.isInteger(activeVersion) || activeVersion <= 0) {
      throw new Error(`${target.key} has no active version to lock; specify --${target.type} ${target.key}@<version>.`);
    }
    version = activeVersion;
  }
  const details = await fetchLockedVersion(api, target.type, target.key, version);
  const props = versionPropsOf(details, target.type) ?? {};
  const envelopeSha = typeof props['canonical_json_sha256'] === 'string' ? props['canonical_json_sha256'] : '';
  if (!envelopeSha) {
    throw new Error(`${target.key}@${version} has no published envelope digest; publish it before locking.`);
  }
  return {
    type: target.type,
    key: target.key,
    version,
    publication_urn: versionUrnOf(details, target.type),
    envelope_sha256: envelopeSha,
    artifacts: artifactSha256s(details),
    locked_at: new Date().toISOString(),
  };
}

async function runVerifyLock(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const lockPath = path.resolve(asString(args['lock-file']) ?? DEFAULT_LOCK_FILE);
  const strict = args.strict === true;
  const lock = await readLockFile(lockPath);
  if (!lock) {
    throw new Error(`Lock file not found: ${lockPath} (run registry-operator lock first).`);
  }
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const now = Date.now();
  const results: Array<{
    type: 'skill' | 'agent';
    key: string;
    version: number;
    verdict: 'verified' | 'failed';
    failures: string[];
    warnings: string[];
    evidence: Record<string, unknown>;
  }> = [];

  for (const entry of lock.entries) {
    const failures: string[] = [];
    const warnings: string[] = [];
    const evidence: Record<string, unknown> = {};
    let details: Record<string, unknown> | null = null;
    try {
      details = await fetchLockedVersion(api, entry.type, entry.key, entry.version);
    } catch (err) {
      if (err instanceof RegistryOperatorApiError && err.status === 404) {
        failures.push('missing');
      } else {
        failures.push('unreachable');
        evidence.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (details) {
      const props = versionPropsOf(details, entry.type) ?? {};
      const urn = versionUrnOf(details, entry.type);
      evidence.publication_urn = urn;
      if (urn && urn !== entry.publication_urn) failures.push('publication_urn_mismatch');
      const lifecycle = String(props['lifecycle_status'] ?? '');
      evidence.lifecycle_status = lifecycle;
      if (props['revoked'] === true || lifecycle === 'revoked' || String(props['publication_status'] ?? '') === 'revoked') {
        failures.push('revoked');
      }
      const liveEnvelope = typeof props['canonical_json_sha256'] === 'string' ? props['canonical_json_sha256'] : '';
      evidence.envelope_sha256 = liveEnvelope;
      if (!liveEnvelope) failures.push('envelope_digest_unavailable');
      else if (liveEnvelope !== entry.envelope_sha256) failures.push('envelope_sha256_drift');
      const liveArtifacts = artifactSha256s(details).sort();
      evidence.artifacts = liveArtifacts;
      if (JSON.stringify(liveArtifacts) !== JSON.stringify([...entry.artifacts].sort())) {
        failures.push('artifact_sha256_drift');
      }
      const expiresAt = typeof props['certification_expires_at'] === 'string' ? props['certification_expires_at'] : '';
      if (expiresAt) {
        evidence.certification_expires_at = expiresAt;
        const parsed = Date.parse(expiresAt);
        if (Number.isFinite(parsed) && parsed <= now) failures.push('certification_expired');
      }
      if (lifecycle === 'deprecated') warnings.push('deprecated');
      try {
        const active =
          entry.type === 'skill'
            ? await api.getActiveSkillVersion(entry.key)
            : await api.getActiveAgentVersion(entry.key);
        const activeVersion = Number(versionPropsOf(active, entry.type)?.['version']);
        if (Number.isInteger(activeVersion) && activeVersion > entry.version) {
          warnings.push('newer_available');
          evidence.active_version = activeVersion;
        }
      } catch {
        // Active-version lookup is informational; a missing one is not drift.
      }
      try {
        const verification =
          entry.type === 'skill'
            ? await api.getSkillPublicationVerification(entry.key, entry.version)
            : await api.getAgentPublicationVerification(entry.key, entry.version);
        const status = String(verification['verification_status'] ?? 'unknown');
        evidence.verification_status = status;
        if (strict && status !== 'verified') failures.push(`verification_status:${status}`);
      } catch (err) {
        evidence.verification_status = 'unavailable';
        if (strict) {
          failures.push('verification_unavailable');
          evidence.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    const finalFailures = strict ? [...failures, ...warnings.map((warning) => `strict:${warning}`)] : failures;
    results.push({
      type: entry.type,
      key: entry.key,
      version: entry.version,
      verdict: finalFailures.length === 0 ? 'verified' : 'failed',
      failures: finalFailures,
      warnings,
      evidence,
    });
  }

  const failed = results.filter((result) => result.verdict === 'failed');
  console.log(
    JSON.stringify(
      {
        lock_file: lockPath,
        strict,
        entries: results,
        verified: failed.length === 0,
        failed_count: failed.length,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    throw new Error(
      `Lock verification failed for ${failed.length} ${failed.length === 1 ? 'entry' : 'entries'}: ${failed
        .map((result) => `${result.key}@${result.version}`)
        .join(', ')}`,
    );
  }
}

// Materialize verified bytes + an integrity manifest (build plan 3.2).
// Everything is checked before anything is written: revocation, envelope
// digest (recomputed locally), detached signatures against trusted keys
// (keyless verdicts from the server), and a local re-hash of every artifact.
async function runPull(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const positionals = asStringArray(args['_']);
  const outRaw = asString(args.out);
  const targets = [
    ...positionals.map((raw) => ({ raw, expected: undefined })),
    ...asStringArray(args.skill).map((raw) => ({ raw, expected: 'skill' as const })),
    ...asStringArray(args.agent).map((raw) => ({ raw, expected: 'agent' as const })),
  ];
  if (!outRaw || targets.length === 0) {
    throw new Error(
      'Usage: registry-operator pull (skill:<key>[@<version>] | agent:<key>[@<version>] ... | --skill <key> | --agent <key>) --out <dir> [--strict]',
    );
  }
  const outDir = path.resolve(outRaw);
  const strict = args.strict === true;
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });

  const pulled: Array<Record<string, unknown>> = [];
  for (const { raw, expected } of targets) {
    const target = parseLockTarget(raw);
    if (expected && target.type !== expected) {
      throw new Error(`Invalid pull target "${raw}": expected a ${expected} key.`);
    }
    pulled.push(await pullTarget(api, target, outDir, strict));
  }
  console.log(JSON.stringify({ out: outDir, strict, pulled }, null, 2));
}

async function pullTarget(
  api: HttpRegistryOperatorApiClient,
  target: { type: 'skill' | 'agent'; key: string; version?: number },
  outDir: string,
  strict: boolean,
): Promise<Record<string, unknown>> {
  let version = target.version;
  if (!version) {
    const active =
      target.type === 'skill'
        ? await api.getActiveSkillVersion(target.key)
        : await api.getActiveAgentVersion(target.key);
    const activeVersion = Number(versionPropsOf(active, target.type)?.['version']);
    if (!Number.isInteger(activeVersion) || activeVersion <= 0) {
      throw new Error(`${target.key} has no active version to pull; specify ${target.key}@<version>.`);
    }
    version = activeVersion;
  }
  const details = await fetchLockedVersion(api, target.type, target.key, version);
  const props = versionPropsOf(details, target.type) ?? {};

  // Fail closed before any bytes are written.
  const lifecycle = String(props['lifecycle_status'] ?? '');
  if (props['revoked'] === true || lifecycle === 'revoked' || String(props['publication_status'] ?? '') === 'revoked') {
    throw new Error(`${target.key}@${version} is revoked; refusing to pull.`);
  }

  const envelope =
    target.type === 'skill'
      ? await api.getSkillPublicationEnvelope(target.key, version)
      : await api.getAgentPublicationEnvelope(target.key, version);
  const verification =
    target.type === 'skill'
      ? await api.getSkillPublicationVerification(target.key, version)
      : await api.getAgentPublicationVerification(target.key, version);

  const canonicalJson = String(envelope['canonical_json'] ?? '');
  const envelopeDigest = String(envelope['canonical_json_sha256'] ?? '');
  if (!canonicalJson || sha256Hex(Buffer.from(canonicalJson, 'utf8')) !== envelopeDigest) {
    throw new Error(`${target.key}@${version} envelope failed local digest verification; refusing to pull.`);
  }
  // The recorded anchor is the frozen publication envelope digest (stable
  // across later evidence attachment); canonical_json_sha256 is the
  // publish-time digest fallback for pre-freeze publications.
  const recordedDigest =
    (typeof props['publication_envelope_sha256'] === 'string' ? props['publication_envelope_sha256'] : '') ||
    (typeof props['canonical_json_sha256'] === 'string' ? props['canonical_json_sha256'] : '');
  if (!recordedDigest || envelopeDigest !== recordedDigest) {
    throw new Error(
      `${target.key}@${version} envelope digest does not match the recorded publication digest; refusing to pull.`,
    );
  }

  // Signature verdicts: trusted keys verified locally over the canonical
  // bytes; keyless verdicts taken from the registry (their trust policy
  // lives there), exactly like `verify publication`.
  const signatures = Array.isArray(envelope['detached_signatures'])
    ? (envelope['detached_signatures'] as Array<{
        artifact_urn?: string;
        key_ref?: string;
        algorithm?: string;
        signed_payload?: 'canonical_json' | 'canonical_rdf';
        envelope_sha256?: string;
        signature?: string;
        keyless?: { identity?: string; issuer?: string };
      }>)
    : [];
  const publicKeys = await loadTrustedPublicKeyPems(
    api,
    signatures
      .filter((signature) => !signature.keyless)
      .map((signature) => signature.key_ref)
      .filter((keyRef): keyRef is string => Boolean(keyRef)),
    undefined,
  );
  const trustedVerdict = verifyEnvelopeSignatures({
    envelope: {
      canonical_json: canonicalJson,
      canonical_json_sha256: envelopeDigest,
      detached_signatures: signatures
        .filter((signature) => !signature.keyless)
        .map((signature) => ({
          key_ref: signature.key_ref ?? '',
          algorithm: signature.algorithm ?? '',
          ...(signature.signed_payload ? { signed_payload: signature.signed_payload } : {}),
          envelope_sha256: signature.envelope_sha256 ?? '',
          signature: signature.signature ?? '',
        })),
    },
    resolvePublicKey: (keyRef) => publicKeys.get(keyRef),
  });
  const serverChecks = Array.isArray(verification['signature_checks'])
    ? (verification['signature_checks'] as Array<{
        artifact_urn?: string;
        key_ref?: string;
        keyless?: { verified?: boolean };
      }>)
    : [];
  const keylessVerified = signatures
    .filter((signature) => signature.keyless)
    .every((signature) => {
      const check =
        serverChecks.find((candidate) => candidate.artifact_urn === signature.artifact_urn) ??
        serverChecks.find((candidate) => candidate.key_ref === signature.key_ref);
      return check?.keyless?.verified === true;
    });
  const trustedValid = trustedVerdict.signatures.every((signature) => signature.signature_valid);
  const validSignatures =
    trustedVerdict.signatures.filter((signature) => signature.signature_valid).length +
    serverChecks.filter((check) => check.keyless?.verified === true).length;
  if (!trustedValid || !keylessVerified) {
    throw new Error(`${target.key}@${version} has an invalid detached signature; refusing to pull.`);
  }

  const serverStatus = String(verification['verification_status'] ?? 'unknown');
  const strictFailures: string[] = [];
  if (strict) {
    if (serverStatus !== 'verified') strictFailures.push(`server verification_status is ${serverStatus}`);
    if (validSignatures === 0) strictFailures.push('no valid detached signature');
    const frozenPresent = verification['publication_envelope_artifact_present'] === true;
    if (frozenPresent && verification['publication_envelope_artifact_sha256_matches'] === false) {
      strictFailures.push('frozen envelope artifact digest mismatch');
    }
  }
  if (strictFailures.length > 0) {
    throw new Error(`${target.key}@${version} failed strict verification (${strictFailures.join('; ')}); refusing to pull.`);
  }

  // Materialize: every artifact is re-hashed locally before it is written.
  const artifacts = Array.isArray(details['artifacts'])
    ? (details['artifacts'] as Array<{ artifact_urn?: string; sha256?: string }>)
    : [];
  const pullDir = targetDirectory(outDir, target.type, target.key, version);
  await mkdir(pullDir, { recursive: true });
  const written: PullManifest['artifacts'] = [];
  const multiple = artifacts.length > 1;
  const sourceBase = sourceFileBaseName(
    typeof props['source_path'] === 'string' ? props['source_path'] : undefined,
  );
  const usedNames = new Set<string>();
  for (const artifact of artifacts) {
    const sha =
      typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256)
        ? artifact.sha256
        : parseArtifactUrnSha256(artifact.artifact_urn ?? '');
    if (!sha) {
      throw new Error(`${target.key}@${version} has an artifact without a digest; refusing to pull.`);
    }
    const { bytes, mediaType } = await api.getArtifactBytes(sha);
    if (sha256Hex(bytes) !== sha) {
      throw new Error(`${target.key}@${version} artifact ${sha} failed local re-hash; refusing to write.`);
    }
    const file = sourceBase
      ? multiple || usedNames.has(sourceBase)
        ? `${sha.slice(0, 8)}-${sourceBase}`
        : sourceBase
      : artifactFileName({ mediaType, sha256: sha, multiple });
    usedNames.add(file);
    await writeFile(path.join(pullDir, file), bytes);
    written.push({ sha256: sha, file, ...(mediaType ? { media_type: mediaType } : {}) });
  }
  await writeFile(path.join(pullDir, 'envelope.json'), canonicalJson, 'utf8');
  const manifest: PullManifest = {
    manifest_version: 1,
    type: target.type,
    key: target.key,
    version,
    publication_urn: versionUrnOf(details, target.type),
    envelope_sha256: envelopeDigest,
    strict,
    server_verification_status: serverStatus,
    valid_signatures: validSignatures,
    frozen_envelope_artifact_present: verification['publication_envelope_artifact_present'] === true,
    live_envelope_matches_frozen_artifact:
      typeof verification['live_envelope_matches_frozen_artifact'] === 'boolean'
        ? verification['live_envelope_matches_frozen_artifact']
        : null,
    artifacts: written,
    pulled_at: new Date().toISOString(),
  };
  await writeFile(path.join(pullDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    type: target.type,
    key: target.key,
    version,
    directory: pullDir,
    artifacts: written,
    server_verification_status: serverStatus,
    valid_signatures: validSignatures,
  };
}

async function fetchLockedVersion(
  api: HttpRegistryOperatorApiClient,
  type: 'skill' | 'agent',
  key: string,
  version: number,
): Promise<Record<string, unknown>> {
  if (type === 'skill') {
    return await api.getSkillVersion(key, version);
  }
  const listing = await api.getAgentVersions(key);
  const versions = Array.isArray(listing['versions']) ? (listing['versions'] as Array<Record<string, unknown>>) : [];
  const found = versions.find((candidate) => Number(versionPropsOf(candidate, 'agent')?.['version']) === version);
  if (!found) {
    throw new RegistryOperatorApiError(`Agent version not found: ${key}@${version}`, 404, 'AGENT_VERSION_NOT_FOUND');
  }
  return found;
}

function versionPropsOf(
  details: Record<string, unknown> | null | undefined,
  type: 'skill' | 'agent',
): Record<string, unknown> | undefined {
  const root = details?.[type === 'skill' ? 'skill_version' : 'agent_version'];
  if (!root || typeof root !== 'object') return undefined;
  const properties = (root as { properties?: unknown }).properties;
  return properties && typeof properties === 'object' ? (properties as Record<string, unknown>) : undefined;
}

function versionUrnOf(details: Record<string, unknown>, type: 'skill' | 'agent'): string {
  const root = details[type === 'skill' ? 'skill_version' : 'agent_version'];
  if (!root || typeof root !== 'object') return '';
  const urn = (root as { urn?: unknown }).urn;
  return typeof urn === 'string' ? urn : '';
}

function artifactSha256s(details: Record<string, unknown>): string[] {
  return Array.isArray(details['artifacts'])
    ? (details['artifacts'] as Array<{ sha256?: unknown }>)
        .map((artifact) => (typeof artifact?.sha256 === 'string' ? artifact.sha256 : ''))
        .filter((sha) => sha.length > 0)
    : [];
}

async function runVerifyArtifact(env: Env, args: Record<string, string | boolean | string[] | undefined>) {  const apiToken = asString(args['api-token']);
  const sha256 = asString(args.sha256) ?? parseArtifactUrnSha256(asString(args['artifact-urn']));
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('Usage: registry-operator verify artifact (--sha256 <hex> | --artifact-urn <urn>) [--api-token <token>]');
  }
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const { bytes, contentDigest } = await api.getArtifactBytes(sha256, apiToken);
  const computed = sha256Hex(bytes);
  const contentDigestMatches = contentDigest ? contentDigestMatchesSha256(contentDigest, sha256) : null;
  const digestVerified = computed === sha256 && contentDigestMatches !== false;
  console.log(
    JSON.stringify(
      {
        sha256,
        size_bytes: bytes.byteLength,
        computed_sha256: computed,
        digest_verified: digestVerified,
        content_digest: contentDigest ?? null,
        content_digest_matches: contentDigestMatches,
      },
      null,
      2,
    ),
  );
  if (!digestVerified) {
    throw new Error('Artifact bytes do not match their digest.');
  }
}

function parseArtifactUrnSha256(urn: string | undefined): string | undefined {
  const match = urn ? /^urn:sg:artifact:sha256:([0-9a-f]{64})$/.exec(urn) : null;
  return match?.[1];
}

// RFC 9530 Content-Digest structured field: sha-256=:BASE64:
function contentDigestMatchesSha256(header: string, sha256HexValue: string): boolean {
  const match = /sha-256=:([^:]+):/.exec(header);
  if (!match) return true;
  return match[1] === Buffer.from(sha256HexValue, 'hex').toString('base64');
}

async function runVerifyOktaConfig(env: Env) {
  const result = await validateOktaConfig(env);
  console.log(JSON.stringify(result, null, 2));
}

async function runVerifyBrowserSession(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  await waitForApiAndGraphReadiness(env);
  await waitForHttpService('webapp', new URL('/healthz', env.WEBAPP_ORIGIN));
  const okta = await validateOktaConfig(env);
  const graphBackend = await detectGraphBackend(env);
  const apiHealth = await fetchHealth(new URL('/healthz', env.API_ORIGIN));
  const webappHealth = await fetchHealth(new URL('/healthz', env.WEBAPP_ORIGIN));
  const manifestPath = asString(args.manifest);
  console.log(
    JSON.stringify(
      {
        okta,
        graph_backend: graphBackend,
        api_health: apiHealth,
        webapp_health: webappHealth,
        ...(manifestPath ? { manifest: resolveManifestPath(env, manifestPath) } : {}),
        next_step: 'Follow service/webapp/knowledge-manager/OKTA_BROWSER_FLOW_RUNBOOK.md for the real browser-based allowed/denied proof.',
      },
      null,
      2,
    ),
  );
}

async function runBootstrapTest(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const manifestPath = resolveManifestPath(env, asString(args.manifest));
  const doReset = Boolean(args.reset);
  const doUp = Boolean(args.up);
  const lane = asString(args.lane) ?? 'api-mcp';

  if (doReset) {
    await runLocalReset(env, { force: args.force });
  }
  if (doUp) {
    await runLocalUp(env);
  }

  await waitForApiAndGraphReadiness(env);
  await waitForMcpAndGraphReadiness(env);

  const apiToken = asString(args['api-token']);
  const mcpToken = asString(args['mcp-token']);
  const apiKey = apiToken
    ? { token: apiToken, key_id: 'provided', owner_label: 'provided' }
    : await createApiKey(env, 'api', asString(args['api-owner-label']) ?? 'Registry Operator API');
  const mcpKey = mcpToken
    ? { token: mcpToken, key_id: 'provided', owner_label: 'provided' }
    : await createApiKey(env, 'mcp', asString(args['mcp-owner-label']) ?? 'Registry Operator MCP');

  const manifest = await readBootstrapManifest(manifestPath);
  const resolved = resolveBootstrapManifest(manifest, manifestPath, {
    profile: asString(args.profile),
    skillItemIds: toStringArray(args['skill-item-id']),
    agentItemIds: toStringArray(args['agent-item-id']),
  });
  const graphBackend = await detectGraphBackend(env);

  if (args['dry-run']) {
    console.log(JSON.stringify({ ok: true, lane, graph_backend: graphBackend, resolved }, null, 2));
    return;
  }

  await seedResolvedBootstrapManifest(env, resolved, apiKey.token);

  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const verifiedSkillKeys: string[] = [];
  for (const skill of resolved.skills) {
    await api.getActiveSkillVersion(skill.draft.skill_key, apiKey.token);
    verifiedSkillKeys.push(skill.draft.skill_key);
  }
  const verifiedAgentKeys: string[] = [];
  for (const agent of resolved.agents) {
    await api.getAgent(agent.agent_key, apiKey.token);
    verifiedAgentKeys.push(agent.agent_key);
  }

  const mcp = new RegistryOperatorMcpClient({ mcpOrigin: env.MCP_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const mcpResult = await mcp.verifyBootstrap({
    token: mcpKey.token,
    agentKeys: resolved.agents.map((agent) => agent.agent_key),
    skillKeys: resolved.skills.map((skill) => skill.draft.skill_key),
  });

  let oktaLane: Record<string, unknown> | undefined;
  if (lane === 'okta-browser') {
    const okta = await validateOktaConfig(env);
    const apiHealth = await fetchHealth(new URL('/healthz', env.API_ORIGIN));
    const webappHealth = await fetchHealth(new URL('/healthz', env.WEBAPP_ORIGIN));
    oktaLane = {
      okta,
      api_health: apiHealth,
      webapp_health: webappHealth,
      next_browser_step:
        'Use service/webapp/knowledge-manager/OKTA_BROWSER_FLOW_RUNBOOK.md to complete the real browser login and allowed/denied write proof over the seeded content.',
    };
  }

  const cursorMcpConfig = buildCursorMcpConfig(env, mcpKey.token);
  const nextPrompts = buildNextPrompts(resolved);
  const mockOktaDemoCommand = buildMockOktaDemoCommand(env);
  const artifacts = await writeBootstrapRunArtifacts(env, {
    manifestPath,
    lane,
    graphBackend,
    resolved,
    apiKey,
    mcpKey,
    cursorMcpConfig,
    nextPrompts,
    mockOktaDemoCommand,
    seededSkills: verifiedSkillKeys,
    seededAgents: verifiedAgentKeys,
    mcpResult,
    oktaLane,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        lane,
        ...(resolved.pack ? { pack: resolved.pack } : {}),
        ...(resolved.profile ? { profile: resolved.profile } : {}),
        graph_backend: graphBackend,
        seeded_skills: verifiedSkillKeys,
        seeded_agents: verifiedAgentKeys,
        api_token: apiKey.token,
        mcp_token: mcpKey.token,
        mcp: mcpResult,
        artifacts,
        cursor_mcp_config: cursorMcpConfig,
        next_prompts: nextPrompts,
        mock_okta_demo_command: mockOktaDemoCommand,
        ...(oktaLane ? { okta_lane: oktaLane } : {}),
        next_manual_step: 'Paste cursor_mcp_config into your MCP client, then run the prompts in next_prompts.',
      },
      null,
      2,
    ),
  );
}

async function seedResolvedBootstrapManifest(env: Env, manifest: ResolvedBootstrapManifest, apiToken: string) {
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const signer = manifest.signing?.enabled
    ? await prepareDemoSigner(env, api, apiToken, manifest.signing.owner)
    : undefined;

  for (const skill of manifest.skills) {
    const drafted = await api.createSkillDraft(skill, apiToken);
    if (skill.tags.length > 0) {
      // Curated discovery metadata lands on the logical entity once the
      // draft has materialized it.
      await api.setSkillTags(skill.draft.skill_key, skill.tags, apiToken);
    }
    await api.validateSkillVersion(
      {
        skill_key: skill.draft.skill_key,
        version: drafted.version,
        author: skill.draft.author,
        ...(skill.validateNote ? { note: skill.validateNote } : {}),
      },
      apiToken,
    );
    if (signer) {
      await signAndPublishSeededSkill(api, apiToken, signer, {
        skill_key: skill.draft.skill_key,
        version: drafted.version,
        author: skill.draft.author,
        ...(skill.publishNote ? { note: skill.publishNote } : {}),
      });
    } else {
      await api.publishSkillVersion(
        {
          skill_key: skill.draft.skill_key,
          version: drafted.version,
          author: skill.draft.author,
          ...(skill.publishNote ? { note: skill.publishNote } : {}),
        },
        apiToken,
      );
    }
    if (skill.certify) {
      await api.certifySkillVersion(
        {
          skill_key: skill.draft.skill_key,
          version: drafted.version,
          author: skill.draft.author,
          ...(skill.certifyNote ? { note: skill.certifyNote } : {}),
        },
        apiToken,
      );
    }
  }

  for (const agent of manifest.agents) {
    await api.createAgent(agent, apiToken);
    if (agent.tags.length > 0) {
      await api.setAgentTags(agent.agent_key, agent.tags, apiToken);
    }
  }

  void env;
}

const DEMO_SIGNING_KEY_REF = 'demo://signet/demo-signing-key';

type DemoSigner = { keyRef: string; owner: string; privateKey: KeyObject };

// Demo signing keys are generated on first use and persisted under
// data/registry-operator/ (never committed), so re-seeding keeps the same
// trusted key instead of accumulating fresh ones.
async function prepareDemoSigner(
  env: Env,
  api: HttpRegistryOperatorApiClient,
  apiToken: string,
  owner: string,
): Promise<DemoSigner> {
  const signingKeyPath = path.join(env.REPO_ROOT, RUN_ARTIFACTS_RELATIVE_DIR, 'demo-signing-key.pem');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await readFile(signingKeyPath, 'utf8'));
  } catch {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    await mkdir(path.dirname(signingKeyPath), { recursive: true });
    await writeFile(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
      mode: 0o600,
    });
  }
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  try {
    await api.createTrustedPublicKey(
      {
        key_ref: DEMO_SIGNING_KEY_REF,
        algorithm: 'ed25519',
        public_key_pem: publicKeyPem,
        owner,
      },
      apiToken,
    );
  } catch (err) {
    // Already registered by a previous seed run.
    if (!(err instanceof RegistryOperatorApiError) || err.status !== 409) throw err;
  }
  return { keyRef: DEMO_SIGNING_KEY_REF, owner, privateKey };
}

// Single-request sign-then-publish: prepare pins the exact envelope publish
// will freeze, the client signs those bytes, and one publish request freezes
// the signed payload. Re-seeding an already-published version (prepare
// conflicts) falls back to the envelope-attach semantics so an existing
// signature is detected instead of duplicated, and a published-but-unsigned
// version can still be repaired.
async function signAndPublishSeededSkill(
  api: HttpRegistryOperatorApiClient,
  apiToken: string,
  signer: DemoSigner,
  input: { skill_key: string; version: number; author: string; note?: string },
): Promise<void> {
  let prepared: Record<string, unknown>;
  try {
    prepared = await api.prepareSkillPublication(
      input.skill_key,
      input.version,
      {
        author: input.author,
        ...(input.note ? { note: input.note } : {}),
      },
      apiToken,
    );
  } catch (err) {
    if (err instanceof RegistryOperatorApiError && err.code === 'SKILL_VERSION_PREPARE_CONFLICT') {
      await signSeededSkill(api, apiToken, signer, input);
      return;
    }
    throw err;
  }
  const canonicalJson = prepared['canonical_json'];
  const preparedPublicationUrn = prepared['prepared_publication_urn'];
  if (
    typeof canonicalJson !== 'string' ||
    canonicalJson.length === 0 ||
    typeof preparedPublicationUrn !== 'string'
  ) {
    throw new Error(`Prepared publication unavailable for signing ${input.skill_key}@v${input.version}.`);
  }
  const signature = `base64:${signBytes(null, Buffer.from(canonicalJson, 'utf8'), signer.privateKey).toString('base64')}`;
  await api.publishSkillVersion(
    {
      skill_key: input.skill_key,
      version: input.version,
      author: input.author,
      ...(input.note ? { note: input.note } : {}),
      prepared_publication_urn: preparedPublicationUrn,
      signatures: [{ signer: signer.owner, key_ref: signer.keyRef, algorithm: 'ed25519', signature }],
    },
    apiToken,
  );
}

async function signSeededSkill(
  api: HttpRegistryOperatorApiClient,
  apiToken: string,
  signer: DemoSigner,
  input: { skill_key: string; version: number },
): Promise<void> {
  const envelope = await api.getSkillPublicationEnvelope(input.skill_key, input.version, apiToken);
  const signatures = Array.isArray(envelope['detached_signatures'])
    ? (envelope['detached_signatures'] as Array<{ key_ref?: string }>)
    : [];
  if (signatures.some((signature) => signature.key_ref === signer.keyRef)) {
    return; // Re-seeding: this key already signed the frozen envelope.
  }
  const canonicalJson = envelope['canonical_json'];
  if (typeof canonicalJson !== 'string' || canonicalJson.length === 0) {
    throw new Error(`Publication envelope unavailable for signing ${input.skill_key}@v${input.version}.`);
  }
  const signature = `base64:${signBytes(null, Buffer.from(canonicalJson, 'utf8'), signer.privateKey).toString('base64')}`;
  await api.createSkillDetachedSignature(
    input.skill_key,
    input.version,
    { signer: signer.owner, key_ref: signer.keyRef, algorithm: 'ed25519', signature },
    apiToken,
  );
}

// Single-request keyless publish: prepare the candidate envelope, exchange
// the CI OIDC identity at Fulcio for a short-lived certificate, sign the
// exact candidate bytes, and publish with the sigstore bundle in one mutating
// request (optionally certifying).
async function runSignKeyless(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const skillKey = asString(args['skill']);
  const agentKey = asString(args['agent']);
  const version = Number(asString(args['version']));
  const author = requireStringArg(args, 'author');
  const apiToken = requireStringArg(args, 'api-token');
  const note = asString(args['note']);
  const fulcioUrl = asString(args['fulcio-url']);
  const rekorUrl = asString(args['rekor-url']);
  const oidcToken = asString(args['oidc-token']);
  if ((!skillKey && !agentKey) || (skillKey && agentKey)) {
    throw new Error('Missing required --skill or --agent argument (exactly one).');
  }
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error('Missing required --version argument (positive integer).');
  }
  const target = skillKey ? `skill ${skillKey}` : `agent ${agentKey}`;
  const api = new HttpRegistryOperatorApiClient({ apiOrigin: env.API_ORIGIN, extraHeaders: cfAccessHeaders(env) });
  const prepared = skillKey
    ? await api.prepareSkillPublication(
        skillKey,
        version,
        {
          author,
          ...(note ? { note } : {}),
        },
        apiToken,
      )
    : await api.prepareAgentPublication(
        agentKey as string,
        version,
        {
          author,
          ...(note ? { note } : {}),
        },
        apiToken,
      );
  const canonicalJson = prepared['canonical_json'];
  const preparedPublicationUrn = prepared['prepared_publication_urn'];
  if (typeof canonicalJson !== 'string' || canonicalJson.length === 0 || typeof preparedPublicationUrn !== 'string') {
    throw new Error(`Prepared publication unavailable for keyless signing ${target}@v${version}.`);
  }
  const signed = await buildKeylessBundle({
    data: Buffer.from(canonicalJson, 'utf8'),
    ...(oidcToken ? { oidcToken } : {}),
    ...(fulcioUrl ? { fulcioBaseURL: fulcioUrl } : {}),
    ...(rekorUrl ? { rekorBaseURL: rekorUrl } : {}),
  });
  const signatures = [{ signer: signed.identity, keyless_bundle: signed.bundle }];
  if (skillKey) {
    await api.publishSkillVersion(
      {
        skill_key: skillKey,
        version,
        author,
        ...(note ? { note } : {}),
        prepared_publication_urn: preparedPublicationUrn,
        signatures,
      },
      apiToken,
    );
  } else {
    await api.publishAgentVersion(
      {
        agent_key: agentKey as string,
        version,
        author,
        ...(note ? { note } : {}),
        prepared_publication_urn: preparedPublicationUrn,
        signatures,
      },
      apiToken,
    );
  }
  let certified = false;
  if (args['certify'] === true) {
    if (skillKey) {
      await api.certifySkillVersion(
        {
          skill_key: skillKey,
          version,
          author,
          ...(note ? { note } : {}),
        },
        apiToken,
      );
    } else {
      await api.certifyAgentVersion(
        {
          agent_key: agentKey as string,
          version,
          author,
          ...(note ? { note } : {}),
        },
        apiToken,
      );
    }
    certified = true;
  }
  console.log(
    JSON.stringify(
      {
        ...(skillKey ? { skill_key: skillKey } : { agent_key: agentKey }),
        version,
        identity: signed.identity,
        issuer: signed.issuer,
        prepared_publication_urn: preparedPublicationUrn,
        published: true,
        certified,
      },
      null,
      2,
    ),
  );
}

async function createApiKey(env: Env, plane: 'api' | 'mcp', ownerLabel: string) {
  const serviceDir = plane === 'api' ? path.join(env.REPO_ROOT, 'service', 'api') : path.join(env.REPO_ROOT, 'service', 'mcp');
  const hostDatabaseUrl = await resolveHostDatabaseUrlForPlane(env, plane);
  const args = ['run', '--silent', 'create-api-key', '--', '--owner-label', ownerLabel];
  if (plane === 'api') {
    // Bootstrap/operator keys need write access: the API defaults
    // management-created keys to read-only and scope enforcement is on by
    // default, so seeding would fail with INSUFFICIENT_SCOPE without this.
    args.push('--scopes', 'read,write');
  }
  const result = await runShell('npm', args, {
    cwd: serviceDir,
    ...(hostDatabaseUrl ? { env: { DATABASE_URL: hostDatabaseUrl } } : {}),
  });
  return AuthCreateApiKeyResultSchema.parse(JSON.parse(result.stdout));
}

async function readBootstrapManifest(manifestPath: string): Promise<BootstrapManifest> {
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  return BootstrapManifestSchema.parse(raw);
}

function resolveProfile(manifest: BootstrapManifest, profileName: string): BootstrapProfile {
  const profile = manifest.profiles?.[profileName];
  if (!profile) {
    throw new Error(`Unknown bootstrap profile: ${profileName}`);
  }
  return profile;
}

function buildSelectionSet(allIds: string[], profileIds?: string[], explicitIds?: string[]) {
  const ids = explicitIds?.length ? explicitIds : profileIds?.length ? profileIds : allIds;
  return new Set(ids);
}

function normalizeSkillRef(ref: string | SkillSeedRef, builtSkillMap: Map<string, SkillSeedPlan>) {
  if (typeof ref === 'string') {
    return ref.startsWith('urn:') ? { skill_urn: ref } : { skill_key: ref };
  }
  if (ref.skill_item_id) {
    const resolved = builtSkillMap.get(ref.skill_item_id);
    if (!resolved) {
      throw new Error(`Unknown skill_item_id reference: ${ref.skill_item_id}`);
    }
    return { skill_key: resolved.draft.skill_key };
  }
  return {
    ...(ref.skill_key ? { skill_key: ref.skill_key } : {}),
    ...(ref.skill_urn ? { skill_urn: ref.skill_urn } : {}),
  };
}

function topologicalOrder<T>(
  items: T[],
  idOf: (item: T) => string,
  depsOf: (item: T) => string[],
  label: string,
) {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: T[] = [];

  function visit(item: T) {
    const id = idOf(item);
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Cycle detected in ${label} dependencies at ${id}.`);
    }
    visiting.add(id);
    for (const dep of depsOf(item)) {
      const depItem = byId.get(dep);
      if (!depItem) continue;
      visit(depItem);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(item);
  }

  for (const item of items) {
    visit(item);
  }
  return ordered;
}

function parseOptions(argv: string[]) {
  const out: Record<string, string | boolean | string[] | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    if (key in out) {
      const current = out[key];
      out[key] = Array.isArray(current) ? [...current, next] : [String(current), next];
    } else {
      out[key] = next;
    }
    i += 1;
  }
  return out;
}

// Positional-aware variant for the single-word commands: `--flag value`
// pairs are consumed as options; everything else is a positional target.
function parseOptionsWithPositionals(argv: string[]): {
  args: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
} {
  const args: Record<string, string | boolean | string[] | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
        continue;
      }
      if (key in args) {
        const current = args[key];
        args[key] = Array.isArray(current) ? [...current, next] : [String(current), next];
      } else {
        args[key] = next;
      }
      i += 1;
    } else {
      positionals.push(token);
    }
  }
  return { args, positionals };
}

function resolveManifestPath(env: Env, provided: string | undefined) {
  if (provided) {
    return path.resolve(provided);
  }
  return path.join(env.REPO_ROOT, DEFAULT_DEMO_MANIFEST_RELATIVE_PATH);
}

function resolveSpecPath(specDir: string, value: string) {
  return path.isAbsolute(value) ? value : path.resolve(specDir, value);
}

function requireStringArg(args: Record<string, string | boolean | string[] | undefined>, key: string) {
  const value = asString(args[key]);
  if (!value) {
    throw new Error(`Missing required --${key} argument.`);
  }
  return value;
}

function asString(value: string | boolean | string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/** Overlay `--cf-access-client-id/-secret` flags onto env (env still wins if no flag). */
function applyCfAccessArgs(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const id = asString(args['cf-access-client-id']);
  const secret = asString(args['cf-access-client-secret']);
  if (id) env.SIGNET_CF_ACCESS_CLIENT_ID = id;
  if (secret) env.SIGNET_CF_ACCESS_CLIENT_SECRET = secret;
}

function toStringArray(value: string | boolean | string[] | undefined) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return [value];
  }
  return undefined;
}

function readObjectField(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function readArrayField(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function readStringField(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function readBooleanField(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

function readNumberField(value: Record<string, unknown> | undefined, key: string) {
  const candidate = value?.[key];
  return typeof candidate === 'number' ? candidate : undefined;
}

export async function validateOktaConfig(env: Env) {
  const apiEnvFile = env.API_ENV_FILE;
  const webappEnvFile = env.WEBAPP_ENV_FILE;
  const apiEnv = await readDotEnvFile(apiEnvFile);
  const webappEnv = await readDotEnvFile(webappEnvFile);

  const apiMissing = collectMissing(apiEnv, [
    'AUTH_MODE',
    'OKTA_MODE',
    'OKTA_ISSUER',
    'OKTA_AUDIENCE',
    'OKTA_REQUIRED_SCOPES',
    'OKTA_GROUPS_CLAIM',
  ]);
  const webappMissing = collectMissing(webappEnv, [
    'AUTH_MODE',
    'OKTA_MODE',
    'OKTA_ISSUER',
    'OKTA_CLIENT_ID',
    'OKTA_REDIRECT_URI',
    'OKTA_SCOPES',
    'DATABASE_URL',
  ]);

  return {
    ok: apiMissing.length === 0 && webappMissing.length === 0,
    api_env_file: apiEnvFile,
    webapp_env_file: webappEnvFile,
    api_missing: apiMissing,
    webapp_missing: webappMissing,
    api_mode: apiEnv.AUTH_MODE,
    webapp_mode: webappEnv.AUTH_MODE,
  };
}

async function fetchHealth(url: URL) {
  try {
    const response = await fetch(url);
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readDotEnvFile(filePath: string) {
  const content = await readFile(filePath, 'utf8');
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[key] = value;
  }
  return values;
}

async function safeReadDotEnvFile(filePath: string) {
  return await readDotEnvFile(filePath).catch(() => ({} as Record<string, string>));
}

async function readGraphBackendConfigs(env: Env): Promise<{
  api: GraphBackendPlaneConfig;
  mcp: GraphBackendPlaneConfig;
}> {
  const apiEnv = await safeReadDotEnvFile(env.API_ENV_FILE);
  const mcpEnv = await safeReadDotEnvFile(env.MCP_ENV_FILE);
  return {
    api: {
      backend: apiEnv.REGISTRY_GRAPH_BACKEND ?? 'unknown',
      ...(apiEnv.REGISTRY_SPARQL_QUERY_URL ? { sparql_query_url: apiEnv.REGISTRY_SPARQL_QUERY_URL } : {}),
      ...(apiEnv.REGISTRY_SPARQL_UPDATE_URL ? { sparql_update_url: apiEnv.REGISTRY_SPARQL_UPDATE_URL } : {}),
      ...(apiEnv.REGISTRY_SPARQL_USERNAME ? { sparql_username: apiEnv.REGISTRY_SPARQL_USERNAME } : {}),
      ...(apiEnv.REGISTRY_SPARQL_PASSWORD ? { sparql_password: apiEnv.REGISTRY_SPARQL_PASSWORD } : {}),
    },
    mcp: {
      backend: mcpEnv.REGISTRY_GRAPH_BACKEND ?? 'unknown',
      ...(mcpEnv.REGISTRY_SPARQL_QUERY_URL ? { sparql_query_url: mcpEnv.REGISTRY_SPARQL_QUERY_URL } : {}),
      ...(mcpEnv.REGISTRY_SPARQL_UPDATE_URL ? { sparql_update_url: mcpEnv.REGISTRY_SPARQL_UPDATE_URL } : {}),
      ...(mcpEnv.REGISTRY_SPARQL_USERNAME ? { sparql_username: mcpEnv.REGISTRY_SPARQL_USERNAME } : {}),
      ...(mcpEnv.REGISTRY_SPARQL_PASSWORD ? { sparql_password: mcpEnv.REGISTRY_SPARQL_PASSWORD } : {}),
    },
  };
}

async function resolveHostDatabaseUrlForPlane(env: Env, plane: 'api' | 'mcp') {
  const envFile = plane === 'api' ? env.API_ENV_FILE : env.MCP_ENV_FILE;
  const values = await safeReadDotEnvFile(envFile);
  const databaseUrl = values.DATABASE_URL;
  if (!databaseUrl) return undefined;
  return mapContainerFileUrlToHost(databaseUrl, env.REPO_ROOT);
}

function mapContainerFileUrlToHost(value: string, repoRoot: string) {
  const prefix = 'file:/workspace/data/';
  if (!value.startsWith(prefix)) {
    return value;
  }
  const relative = value.slice(prefix.length);
  return `file:${path.join(repoRoot, 'data', relative)}`;
}

function collectMissing(values: Record<string, string>, requiredKeys: string[]) {
  return requiredKeys.filter((key) => !(values[key]?.length));
}

export async function detectGraphBackend(env: Env) {
  const configs = await readGraphBackendConfigs(env);
  const apiGraphBackend = configs.api.backend;
  const mcpGraphBackend = configs.mcp.backend;

  return {
    api: {
      backend: apiGraphBackend,
      ...(configs.api.sparql_query_url ? { sparql_query_url: normalizeHostFacingUrl(configs.api.sparql_query_url) } : {}),
      ...(configs.api.sparql_update_url ? { sparql_update_url: normalizeHostFacingUrl(configs.api.sparql_update_url) } : {}),
    },
    mcp: {
      backend: mcpGraphBackend,
      ...(configs.mcp.sparql_query_url ? { sparql_query_url: normalizeHostFacingUrl(configs.mcp.sparql_query_url) } : {}),
      ...(configs.mcp.sparql_update_url ? { sparql_update_url: normalizeHostFacingUrl(configs.mcp.sparql_update_url) } : {}),
    },
    lane:
      apiGraphBackend === 'sparql' || mcpGraphBackend === 'sparql'
        ? 'jena-first'
        : apiGraphBackend === 'json_file' && mcpGraphBackend === 'json_file'
          ? 'local-json-default'
          : 'mixed',
  };
}

export function normalizeHostFacingUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === 'registry-graph') {
      url.hostname = 'localhost';
    }
    return url.toString();
  } catch {
    return value;
  }
}

async function waitForApiAndGraphReadiness(env: Env) {
  await waitForHttpService('api', new URL('/healthz', env.API_ORIGIN));
  const configs = await readGraphBackendConfigs(env);
  await waitForSparqlTargets(collectSparqlTargets([configs.api]));
}

async function waitForMcpAndGraphReadiness(env: Env) {
  await waitForHttpService('mcp', new URL('/healthz', env.MCP_ORIGIN));
  const configs = await readGraphBackendConfigs(env);
  await waitForSparqlTargets(collectSparqlTargets([configs.mcp]));
}

type SparqlTarget = {
  queryUrl: string;
  updateUrl: string;
  username?: string;
  password?: string;
};

export function collectSparqlTargets(configs: GraphBackendPlaneConfig[]) {
  const targets: SparqlTarget[] = [];
  const seen = new Set<string>();
  for (const cfg of configs) {
    if (cfg.backend !== 'sparql' || !cfg.sparql_query_url) continue;
    const queryUrl = normalizeHostFacingUrl(cfg.sparql_query_url);
    const updateUrl = normalizeHostFacingUrl(cfg.sparql_update_url ?? deriveUpdateUrl(cfg.sparql_query_url));
    const dedupeKey = `${queryUrl}|${updateUrl}|${cfg.sparql_username ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    targets.push({
      queryUrl,
      updateUrl,
      ...(cfg.sparql_username ? { username: cfg.sparql_username } : {}),
      ...(cfg.sparql_password ? { password: cfg.sparql_password } : {}),
    });
  }
  return targets;
}

async function waitForHttpService(name: string, url: URL, timeoutMs = 90_000) {
  const startedAt = Date.now();
  let delayMs = 500;
  let lastError = 'not started';
  while (Date.now() - startedAt < timeoutMs) {
    const health = await fetchHealth(url);
    if (health.ok) {
      return;
    }
    lastError = 'error' in health ? String(health.error) : `status ${health.status}`;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5_000);
  }
  throw new Error(`Timed out waiting for ${name} readiness at ${url.toString()}: ${lastError}`);
}

async function waitForSparqlTargets(targets: SparqlTarget[], timeoutMs = 90_000) {
  for (const target of targets) {
    await waitForSparqlReady(target, timeoutMs);
  }
}

async function waitForSparqlReady(target: SparqlTarget, timeoutMs: number) {
  const startedAt = Date.now();
  let delayMs = 500;
  let lastError = 'not ready';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const headers = new Headers({
        'content-type': 'application/sparql-query',
        accept: 'application/sparql-results+json',
      });
      applyBasicAuthHeader(headers, target.username, target.password);
      const response = await fetch(target.queryUrl, {
        method: 'POST',
        headers,
        body: 'ASK {}',
      });
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5_000);
  }
  throw new Error(`Timed out waiting for SPARQL readiness at ${target.queryUrl}: ${lastError}`);
}

async function clearSparqlDatasetsForReset(env: Env) {
  const configs = await readGraphBackendConfigs(env);
  const targets = collectSparqlTargets([configs.api, configs.mcp]);
  if (targets.length === 0) {
    return;
  }

  // Both paths below either reach readiness or throw: the first attempt is
  // given a short window, then the graph service is started and the wait is
  // repeated without a deadline of its own.
  try {
    await waitForSparqlTargets(targets, 5_000);
  } catch {
    await runShell(
      'docker',
      ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml', 'up', '-d', 'registry-graph'],
      { cwd: path.join(env.REPO_ROOT, 'infra') },
    );
    await waitForSparqlTargets(targets);
  }

  for (const target of targets) {
    const headers = new Headers({
      'content-type': 'application/sparql-update',
    });
    applyBasicAuthHeader(headers, target.username, target.password);
    const response = await fetch(target.updateUrl, {
      method: 'POST',
      headers,
      body: 'CLEAR ALL',
    });
    if (!response.ok) {
      throw new Error(`Failed to clear SPARQL dataset at ${target.updateUrl} (${response.status})`);
    }
  }
  console.log('SPARQL dataset cleared.');
}

function applyBasicAuthHeader(headers: Headers, username?: string, password?: string) {
  if (!username || !password) return;
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  headers.set('authorization', `Basic ${token}`);
}

function deriveUpdateUrl(queryUrl: string) {
  return queryUrl.endsWith('/sparql') ? `${queryUrl.slice(0, -'/sparql'.length)}/update` : queryUrl;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCursorMcpConfig(env: Env, mcpToken: string) {
  return {
    mcpServers: {
      'signet': {
        url: new URL('/mcp', env.MCP_ORIGIN).toString(),
        headers: {
          Authorization: `Bearer ${mcpToken}`,
        },
      },
    },
  };
}

function buildNextPrompts(resolved: ResolvedBootstrapManifest) {
  if (resolved.pack?.pack_id === 'blessed-first-user-demo') {
    return [
      'Use registry.list_agents to find the registry demo agent.',
      'Use registry.get_agent to load cursor:registry-agent and summarize its linked skills.',
      'Use registry.list_skills to find the tame llama skill.',
      'Use registry.get_skill to load skill:tame-llama.',
      'Now answer: How do we tame a llama?',
    ];
  }

  const firstAgent = resolved.agents[0]?.agent_key;
  const firstSkill = resolved.skills[0]?.draft.skill_key;
  return [
    `Use registry.list_agents to find ${firstAgent ?? 'the seeded agent'}.`,
    `Use registry.get_agent to load ${firstAgent ?? 'the seeded agent'} and summarize its linked skills.`,
    `Use registry.list_skills to find ${firstSkill ?? 'the seeded skill'}.`,
    `Use registry.get_skill to load ${firstSkill ?? 'the seeded skill'}.`,
  ];
}

function buildMockOktaDemoCommand(env: Env) {
  const webappDir = path.join(env.REPO_ROOT, 'service', 'webapp', 'knowledge-manager');
  return `cd ${webappDir} && npx playwright install chromium && npm run demo:mock-okta`;
}

async function writeBootstrapRunArtifacts(
  env: Env,
  input: {
    manifestPath: string;
    lane: string;
    graphBackend: Awaited<ReturnType<typeof detectGraphBackend>>;
    resolved: ResolvedBootstrapManifest;
    apiKey: AuthCreateApiKeyResult;
    mcpKey: AuthCreateApiKeyResult;
    cursorMcpConfig: ReturnType<typeof buildCursorMcpConfig>;
    nextPrompts: string[];
    mockOktaDemoCommand: string;
    seededSkills: string[];
    seededAgents: string[];
    mcpResult: unknown;
    oktaLane?: Record<string, unknown>;
  },
) {
  const runId = randomUUID();
  const packId = sanitizePathSegment(input.resolved.pack?.pack_id ?? 'adhoc-pack');
  const packDir = path.join(env.REPO_ROOT, RUN_ARTIFACTS_RELATIVE_DIR, packId);
  const resumeFile = path.join(packDir, 'resume.json');
  const reportFile = path.join(packDir, `report-${runId}.json`);
  await mkdir(packDir, { recursive: true });

  const report = {
    run_id: runId,
    created_at: new Date().toISOString(),
    lane: input.lane,
    manifest: input.manifestPath,
    ...(input.resolved.pack ? { pack: input.resolved.pack } : {}),
    ...(input.resolved.profile ? { profile: input.resolved.profile } : {}),
    graph_backend: input.graphBackend,
    seeded_skills: input.seededSkills,
    seeded_agents: input.seededAgents,
    credentials: {
      api: redactIssuedKey(input.apiKey),
      mcp: redactIssuedKey(input.mcpKey),
    },
    cursor_mcp_config: {
      ...input.cursorMcpConfig,
      mcpServers: {
        'signet': {
          url: input.cursorMcpConfig.mcpServers['signet'].url,
          headers: {
            Authorization: '[REDACTED]',
          },
        },
      },
    },
    next_prompts: input.nextPrompts,
    mock_okta_demo_command: input.mockOktaDemoCommand,
    mcp: input.mcpResult,
    ...(input.oktaLane ? { okta_lane: input.oktaLane } : {}),
  };

  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(
    resumeFile,
    `${JSON.stringify(
      {
        run_id: runId,
        latest_report_file: reportFile,
        pack_dir: packDir,
        manifest: input.manifestPath,
        ...(input.resolved.pack ? { pack: input.resolved.pack } : {}),
        ...(input.resolved.profile ? { profile: input.resolved.profile } : {}),
        lane: input.lane,
        graph_backend: input.graphBackend,
        credentials: {
          api: redactIssuedKey(input.apiKey),
          mcp: redactIssuedKey(input.mcpKey),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    run_id: runId,
    pack_dir: packDir,
    resume_file: resumeFile,
    report_file: reportFile,
  };
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function redactIssuedKey(value: AuthCreateApiKeyResult) {
  return {
    key_id: value.key_id,
    owner_label: value.owner_label,
    token_present: value.token.length > 0,
    token_sha256_prefix: createHash('sha256').update(value.token, 'utf8').digest('hex').slice(0, 12),
  };
}

async function runShell(
  command: string,
  args: string[],
  input: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...input.env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr || stdout}`));
      }
    });
  });
}
