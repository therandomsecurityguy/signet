import { createHash, randomUUID, generateKeyPairSync, createPrivateKey, createPublicKey, sign as signBytes, type KeyObject } from 'node:crypto';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { z } from 'zod';

import { buildKeylessBundle } from './keyless.js';
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
import { sha256Hex, verifyEnvelopeSignatures } from './clients/verify.js';
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
      action: 'api' | 'mcp' | 'okta-config' | 'browser-session' | 'publication' | 'artifact';
      args: Record<string, string | boolean | string[] | undefined>;
    }
  | { group: 'bootstrap'; action: 'test'; args: Record<string, string | boolean | string[] | undefined> }
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
      return await runVerifyBrowserSession(env, command.args);
    case 'bootstrap':
      return await runBootstrapTest(env, command.args);
    case 'sign':
      return await runSignKeyless(env, command.args);
  }
}

export function parseArgs(argv: string[]): CliCommand {
  const [group, action, ...rest] = argv;
  if (!group || !action) {
    throw new Error('Usage: registry-operator <group> <action> [--options]');
  }
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
  if (group === 'verify' && (action === 'api' || action === 'mcp' || action === 'okta-config' || action === 'browser-session' || action === 'publication' || action === 'artifact')) {
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

  // Resolve every trusted signing key to its PEM (stored as a CAS artifact).
  // Keyless signatures carry no registered key: their trust policy lives with
  // the registry, so their verdict is taken from the server verification.
  const publicKeys = new Map<string, string>();
  for (const keyRef of new Set(
    signatures.filter((signature) => !signature.keyless).map((signature) => signature.key_ref).filter(Boolean),
  )) {
    if (!keyRef) continue;
    try {
      const key = await api.getPublicKey(keyRef, apiToken);
      const artifacts = Array.isArray(key['artifacts']) ? (key['artifacts'] as Array<{ artifact_urn?: string }>) : [];
      const sha = parseArtifactUrnSha256(artifacts[0]?.artifact_urn);
      if (!sha) continue;
      const { bytes } = await api.getArtifactBytes(sha, apiToken);
      publicKeys.set(keyRef, new TextDecoder().decode(bytes));
    } catch {
      // Unresolvable keys stay absent; their signatures fail verification.
    }
  }

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

async function runVerifyArtifact(env: Env, args: Record<string, string | boolean | string[] | undefined>) {
  const apiToken = asString(args['api-token']);
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
  const result = await runShell(
    'npm',
    ['run', '--silent', 'create-api-key', '--', '--owner-label', ownerLabel],
    {
      cwd: serviceDir,
      ...(hostDatabaseUrl ? { env: { DATABASE_URL: hostDatabaseUrl } } : {}),
    },
  );
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
