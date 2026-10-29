import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { itemTable } from './item.apply';

type Row = Record<string, unknown>;

const UOMS: Record<string, bigint> = { EA: 1n, GR: 2n, KG: 3n };

function fake(item: Row | null = null) {
  const writes: { op: string; data: Row }[] = [];
  const tx = {
    uom: {
      findMany: async (a: { where: { uom_code: { in: string[] } } }) =>
        a.where.uom_code.in
          .filter((code) => UOMS[code] !== undefined)
          .map((code) => ({ uom_code: code, uom_id: UOMS[code] })),
    },
    item: {
      findUnique: async () => item,
      create: async (a: { data: Row }) => writes.push({ op: 'create', data: a.data }),
      update: async (a: { data: Row }) => writes.push({ op: 'update', data: a.data }),
    },
  };
  return { tx: tx as unknown as Tx, writes };
}

function erp(extra: Row = {}): RelayRow {
  return {
    MES_INF_ID: 1,
    PLANT_CD: 'PL11',
    ITEM_CD: '040101-00016',
    IF_SEQ: 1,
    CREATE_TYPE: 'A',
    ITEM_NM: 'RESIN PC',
    SPEC: 'PC, LD7700, V-2, NATURAL',
    ITEM_ACCT_CD: '30',
    ITEM_GROUP_CD: 'ZZ400',
    BASIC_UNIT: 'GR',
    ...extra,
  };
}

const ITEM = {
  item_id: 7n,
  item_code: '040101-00016',
  item_name: 'RESIN PC',
  item_type_code: 'RAW_MATERIAL',
  base_uom_id: 2n,
  erp_spec: 'PC, LD7700, V-2, NATURAL',
  erp_item_group_code: 'ZZ400',
  is_active: true,
};

describe('itemTable', () => {
  it('처음 받으면 ERP 원본 칸으로 만들고 이름을 베트남어 칸에도 두고 IQC 를 켠다', async () => {
    const f = fake();

    await itemTable.apply(f.tx, erp());

    expect(f.writes).toEqual([
      {
        op: 'create',
        data: {
          item_code: '040101-00016',
          item_name: 'RESIN PC',
          item_type_code: 'RAW_MATERIAL',
          erp_spec: 'PC, LD7700, V-2, NATURAL',
          erp_item_group_code: 'ZZ400',
          name_vi: 'RESIN PC',
          base_uom_id: 2n,
          inspection_required: true,
          is_active: true,
        },
      },
    ]);
  });

  it.each([
    ['10', 'FINISHED'],
    ['20', 'SEMI_FINISHED'],
    ['35', 'SUBSIDIARY_MATERIAL'],
    ['50', 'MERCHANDISE'],
  ])('품목계정 %s 는 %s 다', async (account, type) => {
    const f = fake();

    await itemTable.apply(f.tx, erp({ ITEM_ACCT_CD: account }));

    expect(f.writes[0].data).toMatchObject({ item_type_code: type });
  });

  it('모르는 품목계정·없는 단위는 실패한다', async () => {
    await expect(itemTable.apply(fake().tx, erp({ ITEM_ACCT_CD: '99' }))).rejects.toThrow(
      '모르는 품목계정 99',
    );
    await expect(itemTable.apply(fake().tx, erp({ BASIC_UNIT: 'BX' }))).rejects.toThrow(
      '단위 BX 이 없다',
    );
  });

  it('같은 값이면 아무것도 바꾸지 않는다 — 다른 공장의 같은 품목도 마찬가지다', async () => {
    const f = fake(ITEM);

    await itemTable.apply(f.tx, erp({ PLANT_CD: 'PL13', ITEM_NM: 'RESIN PC ', BASIC_UNIT: 'GR ' }));

    expect(f.writes).toEqual([]);
  });

  it('원본 칸이 바뀌면 고치고, 번역 이름·사용 여부는 건드리지 않는다', async () => {
    const f = fake({ ...ITEM, is_active: false });

    await itemTable.apply(f.tx, erp({ ITEM_NM: 'RESIN PC (N)', SPEC: '' }));

    expect(f.writes).toEqual([
      {
        op: 'update',
        data: {
          item_name: 'RESIN PC (N)',
          item_type_code: 'RAW_MATERIAL',
          erp_spec: null,
          erp_item_group_code: 'ZZ400',
          updated_by: null,
          version_no: { increment: 1 },
        },
      },
    ]);
  });

  it('취소(C)면 끈다', async () => {
    const f = fake(ITEM);

    await itemTable.apply(f.tx, erp({ CREATE_TYPE: 'C' }));

    expect(f.writes).toEqual([
      { op: 'update', data: expect.objectContaining({ is_active: false }) },
    ]);
  });

  it('기본단위가 바뀌면 고치지 않고 실패한다', async () => {
    const f = fake(ITEM);

    await expect(itemTable.apply(f.tx, erp({ BASIC_UNIT: 'KG' }))).rejects.toThrow(
      '기본단위가 바뀌었다',
    );
    expect(f.writes).toEqual([]);
  });
});
