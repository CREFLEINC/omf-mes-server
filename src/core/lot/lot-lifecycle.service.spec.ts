import { LotLifecycleService } from './lot-lifecycle.service';
import { Tx } from './lot-registry.service';

type Args = Record<string, unknown>;
type LotSeed = { lot_id: bigint; lifecycle_status_code: string | null };

/** `lot-registry.service.spec.ts` 와 같은 틀 — 어느 객체로 읽고 썼는지가 이 스위트의 목이다. */
function fake(lots: LotSeed[]) {
  const calls: string[] = [];
  const args: Args[] = [];
  const record =
    <T>(name: string, result: (a: Args) => T) =>
    async (a: Args) => {
      calls.push(name);
      args.push(a);
      return result(a);
    };
  const tx = {
    lot: {
      findMany: record('lot.findMany', () => lots),
      update: record('lot.update', () => ({})),
    },
    lot_lifecycle_history: { create: record('history.create', () => ({})) },
  };
  return { tx: tx as unknown as Tx, calls, args };
}

const input = (lotIds: bigint[], action = 'work-order-close') => ({
  lotIds,
  action,
  sourceDocumentTypeCode: 'WORK_ORDER',
  sourceDocumentId: 55n,
  changedAt: new Date('2026-09-06T01:00:00Z'),
});

describe('LotLifecycleService', () => {
  const service = new LotLifecycleService();

  it('생명주기 — from 밖의 LOT 은 던지지 않고 건너뛰며 movedLotIds 가 아니라 skippedLotIds 에 실린다', async () => {
    // 마감(`WAITING`→`VOIDED`)의 대상 집합은 호출자가 고른다 — 이미 실적이 붙은
    // `ACTIVE` 나 생명주기 칸이 NULL 인 자재 LOT 이 섞여도 코어는 멈추지 않는다.
    const { tx, calls } = fake([
      { lot_id: 1n, lifecycle_status_code: 'WAITING' },
      { lot_id: 2n, lifecycle_status_code: 'ACTIVE' },
      { lot_id: 3n, lifecycle_status_code: null },
    ]);

    const result = await service.moveWithin(tx, input([1n, 2n, 3n]));

    expect(result).toEqual({ movedLotIds: [1n], skippedLotIds: [2n, 3n] });
    expect(calls.filter((c) => c === 'lot.update')).toHaveLength(1);
  });

  it('생명주기 — 옮긴 LOT 마다 이력 한 줄을 쓰고 transition_code 는 전이표가 준다', async () => {
    const { tx, calls, args } = fake([
      { lot_id: 1n, lifecycle_status_code: 'WAITING' },
      { lot_id: 2n, lifecycle_status_code: 'ACTIVE' },
    ]);

    const result = await service.moveWithin(tx, input([1n, 2n], 'work-order-cancel'));

    expect(result.movedLotIds).toEqual([1n, 2n]);
    const histories = args.filter((_, i) => calls[i] === 'history.create');
    expect(histories).toHaveLength(2);
    expect(histories[0].data).toMatchObject({
      lot_id: 1n,
      from_lifecycle_status_code: 'WAITING',
      to_lifecycle_status_code: 'VOIDED',
      transition_code: 'L3',
      source_document_type_code: 'WORK_ORDER',
      source_document_id: 55n,
    });
    expect(histories[1].data).toMatchObject({ from_lifecycle_status_code: 'ACTIVE' });
  });

  it('생명주기 — 등록되지 않은 액션은 던진다', async () => {
    const { tx, calls } = fake([{ lot_id: 1n, lifecycle_status_code: 'WAITING' }]);

    await expect(service.moveWithin(tx, input([1n], 'work-order-scrap'))).rejects.toThrow(
      /상태 전이가 등록되지 않았다/,
    );
    // 빈 집합은 읽지도 않는다.
    expect(await service.moveWithin(tx, input([], 'work-order-close'))).toEqual({
      movedLotIds: [],
      skippedLotIds: [],
    });
    expect(calls).not.toContain('lot.findMany');
    // 빈 집합이라도 미등록 액션은 던진다 — 마감의 「실적 없는 슬롯 0건」이 가드를 끄지 않는다.
    await expect(service.moveWithin(tx, input([], 'work-order-scrap'))).rejects.toThrow(
      /상태 전이가 등록되지 않았다/,
    );
  });

  it('생명주기 — 못 찾은 id 는 skippedLotIds 에 실려 moved + skipped 가 입력 집합과 같다', async () => {
    const { tx, args } = fake([{ lot_id: 1n, lifecycle_status_code: 'WAITING' }]);

    const result = await service.moveWithin(tx, input([1n, 9n]));

    expect(result).toEqual({ movedLotIds: [1n], skippedLotIds: [9n] });
    // 응답에 실리는 칸이 바뀌므로 ETag 도 올린다.
    expect(args.find((a) => 'data' in a && 'lifecycle_status_code' in (a.data as object))?.data).toEqual({
      lifecycle_status_code: 'VOIDED',
      version_no: { increment: 1 },
    });
  });
});
