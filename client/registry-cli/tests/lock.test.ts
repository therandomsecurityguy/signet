import { describe, expect, it } from 'vitest';

import {
  parseLockFile,
  parseLockTarget,
  serializeLockFile,
  upsertLockEntries,
  type LockEntry,
  type SignetLockFile,
} from '../src/lock.js';

const entry = (overrides: Partial<LockEntry> = {}): LockEntry => ({
  type: 'skill',
  key: 'skill:example',
  version: 1,
  publication_urn: 'urn:sg:skill-version:skill:example@v1',
  envelope_sha256: 'a'.repeat(64),
  artifacts: ['b'.repeat(64)],
  locked_at: '2026-11-26T00:00:00.000Z',
  ...overrides,
});

describe('signet.lock file format', () => {
  it('parses lock targets with and without versions', () => {
    expect(parseLockTarget('skill:foo')).toEqual({ type: 'skill', key: 'skill:foo' });
    expect(parseLockTarget('skill:foo@3')).toEqual({ type: 'skill', key: 'skill:foo', version: 3 });
    expect(parseLockTarget('agent:cursor:helper@12')).toEqual({
      type: 'agent',
      key: 'agent:cursor:helper',
      version: 12,
    });
    expect(() => parseLockTarget('foo:bar')).toThrow(/Invalid lock target/);
    expect(() => parseLockTarget('skill:foo@x')).toThrow(/Invalid lock target/);
  });

  it('round-trips a lock file', () => {
    const lock: SignetLockFile = {
      lock_version: 1,
      generated_at: '2026-11-26T00:00:00.000Z',
      updated_at: '2026-11-26T00:00:00.000Z',
      entries: [entry()],
    };
    const parsed = parseLockFile(serializeLockFile(lock));
    expect(parsed).toEqual(lock);
  });

  it('rejects malformed lock files with descriptive errors', () => {
    expect(() => parseLockFile('not json')).toThrow(/not valid JSON/);
    expect(() => parseLockFile('{"lock_version":2,"entries":[]}')).toThrow(/not a supported lock file/);
    expect(() =>
      parseLockFile(JSON.stringify({ lock_version: 1, entries: [{ type: 'skill' }] })),
    ).toThrow(/invalid entry/);
  });

  it('upserts by (type, key) and preserves unrelated entries', () => {
    const existing: SignetLockFile = {
      lock_version: 1,
      generated_at: '2026-11-25T00:00:00.000Z',
      updated_at: '2026-11-25T00:00:00.000Z',
      entries: [
        entry({ key: 'skill:keep', version: 2 }),
        entry({ key: 'skill:replace', version: 1 }),
        entry({ type: 'agent', key: 'agent:cursor:a', version: 1 }),
      ],
    };
    const updated = upsertLockEntries(
      existing,
      [entry({ key: 'skill:replace', version: 5 }), entry({ type: 'agent', key: 'agent:cursor:b', version: 2 })],
      '2026-11-26T00:00:00.000Z',
    );
    expect(updated.generated_at).toBe('2026-11-25T00:00:00.000Z');
    expect(updated.updated_at).toBe('2026-11-26T00:00:00.000Z');
    const byKey = new Map(updated.entries.map((candidate) => [`${candidate.type}:${candidate.key}`, candidate]));
    expect(byKey.get('skill:skill:replace')?.version).toBe(5);
    expect(byKey.get('skill:skill:keep')?.version).toBe(2);
    expect(byKey.get('agent:agent:cursor:a')?.version).toBe(1);
    expect(byKey.get('agent:agent:cursor:b')?.version).toBe(2);
  });

  it('creates a fresh lock when no file existed', () => {
    const updated = upsertLockEntries(null, [entry()], '2026-11-26T00:00:00.000Z');
    expect(updated.generated_at).toBe('2026-11-26T00:00:00.000Z');
    expect(updated.entries).toHaveLength(1);
  });

  it('serializes entries in a deterministic order', () => {
    const lock = upsertLockEntries(
      null,
      [entry({ key: 'skill:zzz' }), entry({ type: 'agent', key: 'agent:a' }), entry({ key: 'skill:aaa' })],
      '2026-11-26T00:00:00.000Z',
    );
    const parsed = JSON.parse(serializeLockFile(lock)) as SignetLockFile;
    expect(parsed.entries.map((candidate) => `${candidate.type}:${candidate.key}`)).toEqual([
      'agent:agent:a',
      'skill:skill:aaa',
      'skill:skill:zzz',
    ]);
  });
});
