import { LotQualityStatusService } from './lot-quality-status.service';
import { Tx } from './lot-registry.service';

type Args = Record<string, unknown>;
type LotSeed = { lot_id: bigint; status_code: string };

/** `lot-lifecycle.service.spec.ts` 와 같은 틀 — 어느 객체로 읽고 썼는지가 이 스위트의 목이다. */
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
    // 잠금 질의라 `findMany` 가 아니라 원문 SQL 이다 — 무엇을 보냈는지도 함께 남긴다.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push('lot.lock');
      args.push({ sql: strings.join('?'), values });
      return lots;
    },
    lot: { update: record('lot.update', () => ({})) },
    lot_status_event: { create: record('event.create', () => ({})) },
  };
  return { tx: tx as unknown as Tx, calls, args };
}

const ctx = {
  changedBy: 7n,
  changedAt: new Date('2026-09-07T02:00:00Z'),
  sourceDocumentTypeCode: 'INSPECTION_RESULT',
  sourceDocumentId: 91n,
};

describe('LotQualityStatusService', () => {
  const service = new LotQualityStatusService();

  it('품질 축 — from 밖의 LOT 은 던지지 않고 건너뛴다 (C14 가 W/O 전건을 옮긴다)', async () => {
    // PQC 확정은 같은 W/O 의 생산LOT 전건이 대상이라 폐기·불량이 섞인다. 하나 때문에
    // 확정 전체가 막히면 안 된다 — 형제 코어(생명주기)와 같은 규약이다.
    const { tx, calls } = fake([
      { lot_id: 1n, status_code: 'NORMAL' },
      { lot_id: 2n, status_code: 'SCRAPPED' },
      { lot_id: 3n, status_code: 'DEFECTIVE' },
    ]);

    const result = await service.moveWithin(tx, [1n, 2n, 3n], 'pqc-acceptance-exceeded', ctx);

    expect(result).toEqual({ movedLotIds: [1n], skippedLotIds: [2n, 3n] });
    expect(calls.filter((c) => c === 'lot.update')).toHaveLength(1);
  });

  it('품질 축 — 못 찾은 id 도 skipped 에 실려 moved + skipped 가 입력 집합과 같다', async () => {
    const { tx, args } = fake([{ lot_id: 1n, status_code: 'INSPECTION_PENDING' }]);

    const result = await service.moveWithin(tx, [1n, 9n], 'inspection-accepted', ctx);

    expect(result).toEqual({ movedLotIds: [1n], skippedLotIds: [9n] });
    // 응답에 실리는 칸이 바뀌므로 ETag 도 올린다.
    expect(args.find((a) => 'data' in a && 'status_code' in (a.data as object))?.data).toEqual({
      status_code: 'NORMAL',
      version_no: { increment: 1 },
    });
  });

  it('품질 축 — 옮긴 LOT 마다 이력 한 줄을 쓰고 transition_code 는 전이표가 준다', async () => {
    const { tx, calls, args } = fake([{ lot_id: 1n, status_code: 'INSPECTION_PENDING' }]);

    await service.moveWithin(tx, [1n], 'inspection-rejected', { ...ctx, reasonCode: 'REJECT' });

    const events = args.filter((_, i) => calls[i] === 'event.create');
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      lot_id: 1n,
      previous_status_code: 'INSPECTION_PENDING',
      new_status_code: 'DEFECTIVE',
      transition_code: 'C6',
      reason_code: 'REJECT',
      changed_by: 7n,
      changed_at: ctx.changedAt,
    });
    // ⛔ 재고 «행»의 차원 셋은 비운다 — 이 전이는 원장을 지나지 않는다.
    const data = events[0].data as Record<string, unknown>;
    expect(data.quality_status_code).toBeUndefined();
    expect(data.inventory_status_code).toBeUndefined();
    expect(data.location_id).toBeUndefined();
  });

  it('품질 축 — 읽기는 FOR UPDATE 로 잠근다 (검사·보류·재등록이 같은 LOT 을 노린다)', async () => {
    const { tx, args, calls } = fake([{ lot_id: 1n, status_code: 'NORMAL' }]);

    await service.moveWithin(tx, [1n], 'lot-hold-claim', ctx);

    expect(String(args[calls.indexOf('lot.lock')].sql)).toContain('FOR UPDATE');
  });

  it('⛔ 등록되지 않은 전이는 던진다 (F-6) — 빈 집합도 가드를 끄지 않는다', async () => {
    const { tx, calls } = fake([{ lot_id: 1n, status_code: 'NORMAL' }]);

    // `SCRAPPED` 로 가는 전이는 계약이 어느 오퍼레이션에도 적지 않았다 — 짓지 않는다.
    await expect(service.moveWithin(tx, [1n], 'lot-scrap', ctx)).rejects.toThrow(
      /상태 전이가 등록되지 않았다/,
    );
    expect(await service.moveWithin(tx, [], 'inspection-accepted', ctx)).toEqual({
      movedLotIds: [],
      skippedLotIds: [],
    });
    expect(calls).not.toContain('lot.lock');
    await expect(service.moveWithin(tx, [], 'lot-scrap', ctx)).rejects.toThrow(
      /상태 전이가 등록되지 않았다/,
    );
  });

  it('⛔ 재등록은 전이표에 코드가 없다 — 호출자가 넘겨야 돈다 (문의 089 · 발행 예정)', async () => {
    const { tx, calls, args } = fake([{ lot_id: 1n, status_code: 'DEFECTIVE' }]);

    // 계약 enum 9값(C4~C15)에 재등록을 가리키는 코드가 없다. 지어내지 않으므로
    // 이력 칸(NOT NULL)을 채울 값이 없고, 그러면 전이 자체가 서지 않는다.
    await expect(service.moveWithin(tx, [1n], 'stock-reinstate', ctx)).rejects.toThrow(
      /transitionCode 가 없다/,
    );

    const result = await service.moveWithin(tx, [1n], 'stock-reinstate', {
      ...ctx,
      transitionCode: 'C99',
    });
    expect(result.movedLotIds).toEqual([1n]);
    expect(args[calls.indexOf('event.create')].data).toMatchObject({
      new_status_code: 'NORMAL',
      transition_code: 'C99',
    });
  });

  it('⭐ R-12 — 원천 문서 id 를 LOT 마다 다르게 싣는다 (N LOT 보류는 자기 lot_hold_id 를 가리킨다)', async () => {
    const { tx, calls, args } = fake([
      { lot_id: 1n, status_code: 'NORMAL' },
      { lot_id: 2n, status_code: 'NORMAL' },
      { lot_id: 3n, status_code: 'NORMAL' },
    ]);

    // 배치 칸 하나만 쓰면 셋이 모두 「첫 lot_hold_id」를 가리켜 계보가 틀린다.
    await service.moveWithin(tx, [1n, 2n, 3n], 'lot-hold-claim', {
      ...ctx,
      sourceDocumentTypeCode: 'LOT_HOLD',
      sourceDocumentId: 41n,
      sourceDocumentIdByLot: new Map([
        [1n, 41n],
        [2n, 42n],
      ]),
    });

    const events = args.filter((_, i) => calls[i] === 'event.create');
    expect(events.map((e) => (e.data as Record<string, unknown>).source_document_id)).toEqual([
      41n,
      42n,
      41n, // 지도에 없는 LOT 은 배치 값으로 떨어진다 — 두 칸 CHECK 를 깨지 않는다.
    ]);
  });

  it('⛔ ck_lot_status_event_source — 지도가 «부분»이고 배치 값이 없으면 던진다(500 을 앞당겨 막는다)', async () => {
    const { tx, calls } = fake([
      { lot_id: 1n, status_code: 'NORMAL' },
      { lot_id: 2n, status_code: 'NORMAL' },
    ]);

    // 지도에 1n 만 있고 배치 `sourceDocumentId` 가 없다 ⇒ 2n 은 유형만 실려 CHECK 가 깨진다.
    await expect(
      service.moveWithin(tx, [1n, 2n], 'lot-hold-claim', {
        changedBy: 7n,
        changedAt: ctx.changedAt,
        sourceDocumentTypeCode: 'LOT_HOLD',
        sourceDocumentIdByLot: new Map([[1n, 41n]]),
      }),
    ).rejects.toThrow(/ck_lot_status_event_source/);
    // 던지기 «전»에 아무것도 잠그거나 쓰지 않았다.
    expect(calls).toEqual([]);
  });

  it('⛔ ck_lot_status_event_source — 원천 문서 두 칸을 함께 비울 수 있다', async () => {
    const { tx, calls, args } = fake([{ lot_id: 1n, status_code: 'INSPECTION_PENDING' }]);

    await service.moveWithin(tx, [1n], 'lot-hold-release-accepted', {
      changedBy: 7n,
      changedAt: ctx.changedAt,
    });

    const data = args[calls.indexOf('event.create')].data as Record<string, unknown>;
    // 한쪽만 채운 행을 만들 길이 없어야 한다 — 코어가 두 칸을 함께 받고 함께 흘린다.
    expect(data.source_document_type_code).toBeUndefined();
    expect(data.source_document_id).toBeUndefined();
  });
});
