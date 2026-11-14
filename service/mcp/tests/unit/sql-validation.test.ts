import { describe, expect, it } from 'vitest';

import { validateReadOnlySql } from '../../src/domain/sql/validation.js';

describe('validateReadOnlySql', () => {
  it('allows SELECT', () => {
    expect(validateReadOnlySql('select 1')).toEqual({ ok: true });
  });

  it('allows WITH ... SELECT', () => {
    expect(
      validateReadOnlySql('with x as (select 1 as a) select * from x'),
    ).toEqual({ ok: true });
  });

  it('denies multiple statements', () => {
    expect(validateReadOnlySql('select 1; select 2')).toEqual({
      ok: false,
      reason: 'multiple_statements',
    });
  });

  it('denies DDL/DML keywords', () => {
    expect(validateReadOnlySql('drop table x')).toEqual({
      ok: false,
      reason: 'not_read_only',
    });
    expect(validateReadOnlySql('select 1; drop table x')).toEqual({
      ok: false,
      reason: 'multiple_statements',
    });
  });

  it('denies comments (conservative v1)', () => {
    expect(validateReadOnlySql('select 1 -- hi')).toEqual({
      ok: false,
      reason: 'sql_comments_not_allowed',
    });
    expect(validateReadOnlySql('/* hi */ select 1')).toEqual({
      ok: false,
      reason: 'sql_comments_not_allowed',
    });
  });
});

