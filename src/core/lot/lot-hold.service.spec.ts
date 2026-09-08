import { Prisma } from '@prisma/client';

import { LockedLot, LotHoldInput, LotHoldService } from './lot-hold.service';
import { Tx } from './lot-registry.service';

type Args = Record<string, unknown>;

const NOW = new Date('2026-09-08T04:00:00Z');
const ACTOR = { by: 7n, at: NOW };
const dec = (v: string) => new Prisma.Decimal(v);

/** `lot-quality-status.service.spec.ts` 와 같은 틀 — **어느 순서로** 읽고 썼는지가 이 스위트의 목이다. */
function fake(lotIds: bigint[]) {
  const calls: string[] = [];
  const args: Args[] = [];
  let nextId = 500n;
  const tx = {
    // 잠금 질의라 `findMany` 가 아니라 원문 SQL 이다 — 무엇을 보냈는지도 함께 남긴다.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push('lot.lock');
      args.push({ sql: strings.join('?'), values });
      return lotIds.map((lot_id) => ({ lot_id, status_code: 'NORMAL', version_no: 1 }));
    },
    lot_hold: {
      create: async (a: Args) => {
        calls.push('lot_hold.create');
        args.push(a);
        return { ...(a.data as Args), lot_hold_id: nextId++ };
      },
    },
  };
  return { tx: tx as unknown as Tx, calls, args };
}

function holdInput(extra: Partial<LotHoldInput> = {}): LotHoldInput {
  return { lotId: 1n, reasonCode: 'SUSPECT_MATERIAL', ...extra };
}

describe('LotHoldService', () => {
  const service = new LotHoldService();

  it('⭐⭐ R-5 — lot 잠금이 보류 쓰기보다 «먼저»고, 한 문장에 id 오름차순이다', async () => {
    const { tx, calls, args } = fake([1n, 2n]);

    const locked = await service.lockLotsWithin(tx, [2n, 1n]);
    await service.holdWithin(tx, locked, [holdInput()], ACTOR);

    expect(calls).toEqual(['lot.lock', 'lot_hold.create']);
    const sql = args[0].sql as string;
    expect(sql).toContain('trace.lot');
    expect(sql).toContain('FOR UPDATE');
    // 나눠 잡으면 두 트랜잭션이 같은 두 LOT 을 반대 순서로 잡아 교착한다(`balance-lock.ts` 선례).
    expect(sql).toContain('ORDER BY lot_id');
  });

  it('⭐⭐ R-5 — 잠그지 않은 LOT 에는 못 쓴다(표식이 순서를 강제한다)', async () => {
    const { tx, calls } = fake([1n]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    await expect(service.holdWithin(tx, locked, [holdInput({ lotId: 9n })], ACTOR)).rejects.toThrow('잠그지 않은 LOT');
    // 던지기 «전»에 쓰지 않았다 — 잠금 밖 쓰기가 한 줄도 새지 않는다.
    expect(calls).toEqual(['lot.lock']);
  });

  it('⭐⭐ R-5 — 여러 LOT 중 «일부»만 잠그고 나머지에 쓰면 던진다', async () => {
    const { tx, calls } = fake([1n]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    // 첫 건은 잠긴 LOT 이라 통과하고, 둘째에서 걸린다 — 배치 등록이 조용히 반만 서면 안 된다.
    await expect(service.holdWithin(tx, locked, [holdInput(), holdInput({ lotId: 2n })], ACTOR)).rejects.toThrow(
      '잠그지 않은 LOT',
    );
    expect(calls).toEqual(['lot.lock', 'lot_hold.create']);
  });

  it('빈 집합은 질의를 안 보낸다 — 빈 `IN (…)` 이 문법 오류다', async () => {
    const { tx, calls } = fake([]);

    expect(await service.lockLotsWithin(tx, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('잠금은 그 LOT 의 지금 상태와 판 번호를 함께 싣는다 — 호출자가 409 를 그 값으로 판정한다', async () => {
    const { tx } = fake([1n]);

    const locked: LockedLot[] = await service.lockLotsWithin(tx, [1n]);

    expect(locked).toEqual([{ lot_id: 1n, status_code: 'NORMAL', version_no: 1 }]);
  });

  it('holdWithin 이 status_code=HELD 와 target_lot_status_code 를 채운다', async () => {
    const { tx, args } = fake([1n, 2n]);
    const locked = await service.lockLotsWithin(tx, [1n, 2n]);

    const rows = await service.holdWithin(
      tx,
      locked,
      [
        holdInput({ targetLotStatusCode: 'DEFECTIVE', holdQty: dec('4'), uomId: 3n, releaseCondition: '재검' }),
        holdInput({ lotId: 2n, targetLotStatusCode: 'INSPECTION_PENDING' }),
      ],
      ACTOR,
    );

    expect(args[1].data).toEqual({
      lot_id: 1n,
      reason_code: 'SUSPECT_MATERIAL',
      status_code: 'HELD',
      target_lot_status_code: 'DEFECTIVE',
      hold_qty: dec('4'),
      uom_id: 3n,
      release_condition: '재검',
      remarks: null,
      held_by: 7n,
      held_at: NOW,
      created_by: 7n,
    });
    // ⛔ 전량 보류는 `hold_qty` 가 NULL 이다 — 0 이 아니다.
    expect(args[2].data).toMatchObject({ lot_id: 2n, hold_qty: null, target_lot_status_code: 'INSPECTION_PENDING' });
    // 반환 순서가 입력 순서여야 호출자가 LOT 마다 `lot_hold_id` 를 되짚는다(R-12).
    expect(rows.map((r) => r.lot_id)).toEqual([1n, 2n]);
  });
});
