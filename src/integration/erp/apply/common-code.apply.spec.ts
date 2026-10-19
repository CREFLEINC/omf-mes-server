import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { commonCodeTable } from './common-code.apply';

type Args = Record<string, unknown>;
type Row = Record<string, unknown>;

/** 코드 그룹·값 두 표를 흉내낸다. 쓰기 호출만 `writes` 에 남긴다. */
function fake(seed: { group?: Row; value?: Row } = {}) {
  const writes: { op: string; data: Args }[] = [];
  const tx = {
    code_group: {
      findUnique: async () => seed.group ?? null,
      create: async (a: Args) => {
        writes.push({ op: 'group.create', data: a.data as Args });
        return { code_group_id: 10n };
      },
      update: async (a: Args) => writes.push({ op: 'group.update', data: a.data as Args }),
    },
    code_value: {
      findUnique: async () => seed.value ?? null,
      create: async (a: Args) => writes.push({ op: 'value.create', data: a.data as Args }),
      update: async (a: Args) => writes.push({ op: 'value.update', data: a.data as Args }),
    },
  };
  return { tx: tx as unknown as Tx, writes };
}

function erp(extra: Row = {}): RelayRow {
  return {
    MES_INF_ID: 1,
    TYPE_CODE: 'UNIT',
    TYPE_NAME: '단위코드',
    CODE: 'GR',
    CODE_NAME: 'Gram',
    T_FLAG: 'I',
    T_SEQ: '1',
    ...extra,
  };
}

const GROUP = {
  code_group_id: 10n,
  group_code: 'UNIT',
  group_name: '단위코드',
  is_system_owned: true,
  is_active: true,
};
const VALUE = {
  code_value_id: 20n,
  code: 'GR',
  code_name: 'Gram',
  name_ko: 'Gram',
  is_active: true,
};

describe('commonCodeTable', () => {
  it('처음 받으면 시스템 소유 그룹과 값을 만든다', async () => {
    const f = fake();

    await commonCodeTable.apply(f.tx, erp());

    expect(f.writes).toEqual([
      {
        op: 'group.create',
        data: { group_code: 'UNIT', group_name: '단위코드', is_system_owned: true },
      },
      {
        op: 'value.create',
        data: {
          code_group_id: 10n,
          code: 'GR',
          code_name: 'Gram',
          name_ko: 'Gram',
          is_active: true,
        },
      },
    ]);
  });

  it('같은 값이면 아무것도 바꾸지 않는다', async () => {
    const f = fake({ group: GROUP, value: VALUE });

    await commonCodeTable.apply(f.tx, erp());

    expect(f.writes).toEqual([]);
  });

  it('바뀐 값만 고치고 version_no 를 올리며 수정자를 비운다', async () => {
    const f = fake({ group: GROUP, value: VALUE });

    await commonCodeTable.apply(f.tx, erp({ CODE_NAME: 'Gram(g)' }));

    expect(f.writes).toEqual([
      {
        op: 'value.update',
        data: {
          code_name: 'Gram(g)',
          name_ko: 'Gram(g)',
          is_active: true,
          updated_by: null,
          version_no: { increment: 1 },
        },
      },
    ]);
  });

  it('화면에서 풀린 그룹은 다시 시스템 소유로 잠근다', async () => {
    const f = fake({ group: { ...GROUP, is_system_owned: false }, value: VALUE });

    await commonCodeTable.apply(f.tx, erp());

    expect(f.writes.map((w) => w.op)).toEqual(['group.update']);
    expect(f.writes[0].data).toMatchObject({ is_system_owned: true });
  });

  it('T_FLAG 가 D 면 지우지 않고 끈다', async () => {
    const f = fake({ group: GROUP, value: VALUE });

    await commonCodeTable.apply(f.tx, erp({ T_FLAG: 'D' }));

    expect(f.writes).toEqual([
      expect.objectContaining({
        op: 'value.update',
        data: expect.objectContaining({ is_active: false }),
      }),
    ]);
  });

  it('코드 앞뒤 공백을 떼고 맞춘다', async () => {
    const f = fake({ group: GROUP, value: VALUE });

    await commonCodeTable.apply(f.tx, erp({ CODE: 'GR ', CODE_NAME: 'Gram ' }));

    expect(f.writes).toEqual([]);
  });

  it('코드가 비어 있으면 실패한다', async () => {
    const f = fake({ group: GROUP });

    await expect(commonCodeTable.apply(f.tx, erp({ CODE: '  ' }))).rejects.toThrow(
      'CODE 이 비어 있다',
    );
  });
});
