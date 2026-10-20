import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { partnerTable } from './partner.apply';

type Row = Record<string, unknown>;

function fake(partner: Row | null = null) {
  const writes: { op: string; args: Row }[] = [];
  const record = (op: string) => async (args: Row) => void writes.push({ op, args });
  const tx = {
    partner: {
      findUnique: async () => partner,
      create: record('partner.create'),
      update: record('partner.update'),
    },
    partner_role: { deleteMany: record('role.delete'), createMany: record('role.create') },
  };
  return { tx: tx as unknown as Tx, writes };
}

function erp(extra: Row = {}): RelayRow {
  return {
    MES_INF_ID: 1,
    BP_CD: '100627',
    BP_NM: 'HUA RUI PLASTICS',
    BP_TYPE: 'CS',
    IF_SEQ: 1,
    CREATE_TYPE: 'A',
    ...extra,
  };
}

function partner(roles: string[], extra: Row = {}): Row {
  return {
    partner_id: 9n,
    partner_code: '100627',
    partner_name: 'HUA RUI PLASTICS',
    erp_partner_code: '100627',
    is_active: true,
    partner_role: roles.map((role_type_code) => ({ role_type_code })),
    ...extra,
  };
}

describe('partnerTable', () => {
  it.each([
    ['S', ['SUPPLIER']],
    ['C', ['CUSTOMER']],
    ['*', ['CUSTOMER']],
    ['CS', ['SUPPLIER', 'CUSTOMER']],
    ['T', []],
  ])('처음 받으면 거래처와 역할을 만든다 — 유형 %s', async (type, roles) => {
    const f = fake();

    await partnerTable.apply(f.tx, erp({ BP_TYPE: type }));

    expect(f.writes).toEqual([
      {
        op: 'partner.create',
        args: {
          data: {
            partner_code: '100627',
            partner_name: 'HUA RUI PLASTICS',
            erp_partner_code: '100627',
            is_active: true,
            partner_role: { create: roles.map((role_type_code) => ({ role_type_code })) },
          },
        },
      },
    ]);
  });

  it('같은 값이면 아무것도 바꾸지 않는다 — 사용자가 붙인 역할이 있어도 마찬가지다', async () => {
    const f = fake(partner(['SUPPLIER', 'CUSTOMER', 'DISPOSAL']));

    await partnerTable.apply(f.tx, erp());

    expect(f.writes).toEqual([]);
  });

  it('유형이 바뀌면 ERP 역할만 맞추고 사용자가 붙인 역할은 남기며 판을 올린다', async () => {
    const f = fake(partner(['SUPPLIER', 'CUSTOMER', 'SUBCONTRACTOR']));

    await partnerTable.apply(f.tx, erp({ BP_TYPE: 'S' }));

    expect(f.writes.map((w) => w.op)).toEqual(['role.delete', 'partner.update']);
    expect(f.writes[0].args).toEqual({
      where: { partner_id: 9n, role_type_code: { in: ['CUSTOMER'] } },
    });
    expect(f.writes[1].args.data).toMatchObject({ version_no: { increment: 1 } });
  });

  it('없던 ERP 역할은 더한다', async () => {
    const f = fake(partner(['CUSTOMER']));

    await partnerTable.apply(f.tx, erp());

    expect(f.writes.map((w) => w.op)).toEqual(['role.create', 'partner.update']);
    expect(f.writes[0].args).toEqual({ data: [{ partner_id: 9n, role_type_code: 'SUPPLIER' }] });
  });

  it('이름이 바뀌면 고친다', async () => {
    const f = fake(partner(['SUPPLIER', 'CUSTOMER']));

    await partnerTable.apply(f.tx, erp({ BP_NM: 'HUA RUI PLASTICS CO.' }));

    expect(f.writes).toEqual([
      {
        op: 'partner.update',
        args: {
          where: { partner_id: 9n },
          data: {
            partner_name: 'HUA RUI PLASTICS CO.',
            erp_partner_code: '100627',
            updated_by: null,
            version_no: { increment: 1 },
          },
        },
      },
    ]);
  });

  it('취소(C)면 지우지 않고 끈다 — A 행은 화면에서 끈 거래처를 다시 켜지 않는다', async () => {
    const cancelled = fake(partner(['SUPPLIER', 'CUSTOMER']));
    await partnerTable.apply(cancelled.tx, erp({ CREATE_TYPE: 'C' }));
    expect(cancelled.writes).toEqual([
      {
        op: 'partner.update',
        args: expect.objectContaining({ data: expect.objectContaining({ is_active: false }) }),
      },
    ]);

    const off = fake(partner(['SUPPLIER', 'CUSTOMER'], { is_active: false }));
    await partnerTable.apply(off.tx, erp());
    expect(off.writes).toEqual([]);
  });

  it('모르는 거래처 유형은 실패한다', async () => {
    await expect(partnerTable.apply(fake().tx, erp({ BP_TYPE: 'X' }))).rejects.toThrow(
      '모르는 거래처 유형 X',
    );
  });
});
