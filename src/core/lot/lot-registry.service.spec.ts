import { ContractException } from '../../common/errors';
import { LotRegisterInput, LotRegistryService, Tx } from './lot-registry.service';

const LOT_ID = 900n;
const LINE_ID = 41;

type Args = Record<string, unknown>;
type Seed = { line?: { lot_id: bigint | null } };

/**
 * 「그 트랜잭션의 표」를 흉내낸다 — 어느 객체로 읽고 썼는지가 이 스위트의 목이라
 * 호출을 부른 순서 그대로 담는다.
 */
function fake(seed: Seed) {
  const calls: string[] = [];
  const args: Args[] = [];
  const record = <T>(name: string, result: (a: Args) => T) => async (a: Args) => {
    calls.push(name);
    args.push(a);
    return result(a);
  };
  let line = seed.line ?? null;
  const tx = {
    lot: {
      create: record('lot.create', () => ({ lot_id: LOT_ID })),
      findUniqueOrThrow: record('lot.findUniqueOrThrow', () => ({ lot_id: LOT_ID, lot_hold: [] })),
    },
    lot_hold: { create: record('lot_hold.create', () => ({})) },
    lot_external_identifier: { create: record('identifier.create', () => ({})) },
    inbound_receipt_line: {
      updateMany: record('line.updateMany', () => {
        const hit = line !== null && line.lot_id === null;
        if (hit) line = { lot_id: LOT_ID };
        return { count: hit ? 1 : 0 };
      }),
      findUnique: record('line.findUnique', () => line),
    },
  };
  return { tx: tx as unknown as Tx, calls, args };
}

function input(extra: Partial<LotRegisterInput> = {}): LotRegisterInput {
  return {
    lotNo: 'SUP-1',
    itemId: 1,
    lotTypeCode: 'MATERIAL',
    plantId: 2,
    initialQty: 10,
    uomId: 3,
    sourceTypeCode: 'INBOUND_RECEIPT_LINE',
    sourceId: LINE_ID,
    ...extra,
  };
}

describe('LotRegistryService', () => {
  const service = new LotRegistryService();

  it('LOT 코어 — 읽기도 tx 로 한다(같은 트랜잭션의 라인을 본다)', async () => {
    // 라인은 «이 트랜잭션 안»에만 있다 — 코어가 다른 연결로 읽으면 못 보고 400 이 된다.
    const { tx, calls, args } = fake({ line: { lot_id: null } });

    await service.createWithin(tx, input(), 7);

    expect(calls).toContain('line.updateMany');
    expect(args[calls.indexOf('line.updateMany')].where).toEqual({
      inbound_receipt_line_id: LINE_ID,
      lot_id: null,
    });
    // 정상 경로는 판별 읽기를 더하지 않는다.
    expect(calls).not.toContain('line.findUnique');
  });

  it('LOT 코어 — 이미 lot_id 가 있는 라인에 다시 채우면 400 STATE_LOCKED 다', async () => {
    const { tx } = fake({ line: { lot_id: 111n } });

    await expect(service.createWithin(tx, input(), 7)).rejects.toMatchObject({
      errors: [{ field: 'sourceId', code: 'STATE_LOCKED' }],
    });
  });

  it('LOT 코어 — 없는 라인이면 400 INVALID 다', async () => {
    const { tx } = fake({});

    const failure = await service.createWithin(tx, input(), 7).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractException);
    expect((failure as ContractException).errors[0]).toMatchObject({
      field: 'sourceId',
      code: 'INVALID',
    });
  });

  it('LOT 코어 — 라인 → LOT → 라인 UPDATE 순서다', async () => {
    const { tx, calls } = fake({ line: { lot_id: null } });

    await service.createWithin(tx, input(), 7);

    // 라인은 코어가 불리기 «전에» 서 있다(`lot.source_id` 가 라인 id 다).
    expect(calls.indexOf('lot.create')).toBeLessThan(calls.indexOf('line.updateMany'));
    expect(calls.indexOf('lot_hold.create')).toBeGreaterThan(calls.indexOf('lot.create'));
  });

  it('LOT 코어 — 입하 라인이 아닌 원천은 라인을 만지지 않는다', async () => {
    const { tx, calls } = fake({});

    await service.createWithin(tx, input({ sourceTypeCode: 'WORK_ORDER' }), 7);

    expect(calls).not.toContain('line.updateMany');
  });
});
