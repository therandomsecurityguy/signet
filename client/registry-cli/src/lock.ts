import { readFile } from 'node:fs/promises';

// signet.lock (build plan 2.2): a per-consumer pin of the exact registry
// publications a repo or agent depends on. `lock` writes/updates it from the
// registry; `verify lock` re-checks every pin fail-closed (drift, revocation,
// expiry) — the "doctor" cadence for CI runs and agent session starts.

export type LockEntry = {
  type: 'skill' | 'agent';
  key: string;
  version: number;
  publication_urn: string;
  /** Canonical JSON (JCS) envelope digest recorded at publish. */
  envelope_sha256: string;
  /** Content addresses of the version's implementation artifacts. */
  artifacts: string[];
  locked_at: string;
};

export type SignetLockFile = {
  lock_version: 1;
  generated_at: string;
  updated_at: string;
  entries: LockEntry[];
};

export const DEFAULT_LOCK_FILE = 'signet.lock';

export function parseLockTarget(raw: string): { type: 'skill' | 'agent'; key: string; version?: number } {
  const match = /^(skill|agent):(.+)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid lock target "${raw}". Expected skill:<key>[@<version>] or agent:<key>[@<version>].`);
  }
  const [, type, rest] = match;
  const at = rest.lastIndexOf('@');
  if (at < 0) {
    return { type: type as 'skill' | 'agent', key: `${type}:${rest}` };
  }
  const versionPart = rest.slice(at + 1);
  const key = rest.slice(0, at);
  if (!/^[1-9]\d*$/.test(versionPart) || key.length === 0) {
    throw new Error(`Invalid lock target "${raw}": "@${versionPart}" is not a positive version number.`);
  }
  return { type: type as 'skill' | 'agent', key: `${type}:${key}`, version: Number(versionPart) };
}

export function parseLockFile(raw: string): SignetLockFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('signet.lock is not valid JSON.');
  }
  const candidate = parsed as Partial<SignetLockFile>;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    candidate.lock_version !== 1 ||
    !Array.isArray(candidate.entries)
  ) {
    throw new Error('signet.lock is not a supported lock file (expected lock_version 1 with entries).');
  }
  const entries = candidate.entries.map((entry): LockEntry => {
    if (
      !entry ||
      (entry.type !== 'skill' && entry.type !== 'agent') ||
      typeof entry.key !== 'string' ||
      typeof entry.version !== 'number' ||
      typeof entry.publication_urn !== 'string' ||
      typeof entry.envelope_sha256 !== 'string' ||
      !Array.isArray(entry.artifacts) ||
      !entry.artifacts.every((sha) => typeof sha === 'string')
    ) {
      throw new Error(`signet.lock contains an invalid entry: ${JSON.stringify(entry)}`);
    }
    return {
      type: entry.type,
      key: entry.key,
      version: entry.version,
      publication_urn: entry.publication_urn,
      envelope_sha256: entry.envelope_sha256,
      artifacts: [...entry.artifacts],
      locked_at: typeof entry.locked_at === 'string' ? entry.locked_at : '',
    };
  });
  return {
    lock_version: 1,
    generated_at: typeof candidate.generated_at === 'string' ? candidate.generated_at : '',
    updated_at: typeof candidate.updated_at === 'string' ? candidate.updated_at : '',
    entries,
  };
}

export async function readLockFile(lockPath: string): Promise<SignetLockFile | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    return parseLockFile(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function serializeLockFile(lock: SignetLockFile): string {
  const sorted: SignetLockFile = {
    ...lock,
    entries: [...lock.entries].sort((left, right) =>
      left.type === right.type
        ? left.key.localeCompare(right.key)
        : left.type.localeCompare(right.type),
    ),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

// Upsert semantics: entries are keyed by (type, key) — re-locking one target
// replaces its pin and never drops the other entries.
export function upsertLockEntries(
  existing: SignetLockFile | null,
  entries: LockEntry[],
  now: string,
): SignetLockFile {
  const byTarget = new Map<string, LockEntry>();
  for (const entry of existing?.entries ?? []) {
    byTarget.set(`${entry.type}:${entry.key}`, entry);
  }
  for (const entry of entries) {
    byTarget.set(`${entry.type}:${entry.key}`, entry);
  }
  return {
    lock_version: 1,
    generated_at: existing?.generated_at || now,
    updated_at: now,
    entries: [...byTarget.values()],
  };
}
