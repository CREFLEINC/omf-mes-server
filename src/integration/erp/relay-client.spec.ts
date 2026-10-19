import * as mssql from 'mssql';

import { keysetAfter } from './relay-client';

function request() {
  const inputs: Record<string, unknown> = {};
  const fake = {
    input: (name: string, value: unknown) => {
      inputs[name] = value;
      return fake;
    },
  };
  return { request: fake as unknown as mssql.Request, inputs };
}

describe('keysetAfter', () => {
  it('앞 칸이 같을 때만 뒤 칸을 비교한다', () => {
    const r = request();

    const sql = keysetAfter(['TYPE_CODE', 'CODE', 'MES_INF_ID'], ['UNIT', 'EA', 7], r.request);

    expect(sql).toBe(
      '((TYPE_CODE > @after0) OR (TYPE_CODE = @after0 AND CODE > @after1) OR ' +
        '(TYPE_CODE = @after0 AND CODE = @after1 AND MES_INF_ID > @after2))',
    );
    expect(r.inputs).toEqual({ after0: 'UNIT', after1: 'EA', after2: 7 });
  });
});
