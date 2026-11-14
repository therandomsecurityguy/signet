import { describe, expect, it } from 'vitest';

import { extractTableRefs } from '../../src/domain/sql/object-extraction.js';

describe('sql object extraction (stage 2)', () => {
  it('extracts simple FROM/JOIN references', () => {
    const refs = extractTableRefs(
      'select * from db.schema.table t join "db2"."sch2"."tbl2" on t.id = 1',
    );
    expect(refs).toEqual([
      { database: 'db', schema: 'schema', table: 'table' },
      { database: 'db2', schema: 'sch2', table: 'tbl2' },
    ]);
  });

  it('handles unqualified tables', () => {
    const refs = extractTableRefs('select 1 from users');
    expect(refs).toEqual([{ table: 'users' }]);
  });

  it('handles backticked and bracketed identifiers', () => {
    const refs = extractTableRefs('select * from `db`.`sch`.`tbl` join [other_tbl] on 1=1');
    expect(refs).toEqual([
      { database: 'db', schema: 'sch', table: 'tbl' },
      { table: 'other_tbl' },
    ]);
  });

  it('yields no refs for non-identifier FROM sources so callers can fail closed', () => {
    expect(extractTableRefs('select * from (select 1) sub')).toEqual([]);
  });
});

