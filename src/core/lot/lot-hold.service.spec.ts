import { Prisma } from '@prisma/client';

import { LockedLot, LotHoldInput, LotHoldRow, LotHoldService } from './lot-hold.service';
import { Tx } from './lot-registry.service';

type Args = Record<string, unknown>;
type Where = { released_at?: null; reason_code?: string; lot_hold_id?: { in: bigint[] } };

const NOW = new Date('2026-09-08T04:00:00Z');
const ACTOR = { by: 7n, at: NOW };
const HELD_REASON = 'SUSPECT_MATERIAL';
const RELEASE = { releaseReasonCode: 'RETEST_PASS', releaseTargetLotStatusCode: 'NORMAL', remarks: '풀었다' };
const dec = (v: string) => new Prisma.Decimal(v);

/**
 * `lot-quality-status.service.spec.ts` 와 같은 틀 — **어느 순서로** 읽고 썼는지가 이 스위트의 목이다.
 * 다만 `lot_hold` 는 절을 «실제로» 걸러 준다: 안 그러면 `released_at IS NULL` 을 지워도 초록이다.
 */
function fake(lotIds: bigint[], seed: LotHoldRow[] = []) {
  const calls: string[] = [];
  const args: Args[] = [];
  const rows = [...seed];
  let nextId = 500n;
  const record =
    <T>(name: string, result: (a: Args) => T) =>
    async (a: Args) => {
      calls.push(name);
      args.push(a);
      return result(a);
    };
  const match = (row: LotHoldRow, where: Where) =>
    (where.released_at === undefined || row.released_at === null) &&
    (where.reason_code === undefined || row.reason_code === where.reason_code) &&
    (where.lot_hold_id === undefined || where.lot_hold_id.in.includes(row.lot_hold_id));
  const tx = {
    // 잠금 질의라 `findMany` 가 아니라 원문 SQL 이다 — 무엇을 보냈는지도 함께 남긴다.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push('lot.lock');
      args.push({ sql: strings.join('?'), values });
      return lotIds.map((lot_id) => ({ lot_id, status_code: 'NORMAL', version_no: 1 }));
    },
    lot_hold: {
      create: record('lot_hold.create', (a) => {
        const row = { ...(a.data as Args), lot_hold_id: nextId++, released_at: null } as unknown as LotHoldRow;
        rows.push(row);
        return row;
      }),
      update: record('lot_hold.update', (a) => {
        const row = rows.find((r) => r.lot_hold_id === (a.where as { lot_hold_id: bigint }).lot_hold_id) as LotHoldRow;
        row.released_at = NOW;
        return row;
      }),
      findMany: record('lot_hold.findMany', (a) => {
        // 정렬도 실제로 지킨다 — 무시하면 `orderBy` 를 'desc' 로 뒤집어도 초록이다.
        const dir = (a.orderBy as { lot_hold_id: string }).lot_hold_id === 'desc' ? -1n : 1n;
        return rows
          .filter((r) => match(r, a.where as Where))
          .sort((x, y) => Number((x.lot_hold_id - y.lot_hold_id) * dir));
      }),
      count: record('lot_hold.count', (a) => rows.filter((r) => match(r, a.where as Where)).length),
    },
  };
  return { tx: tx as unknown as Tx, calls, args };
}

function holdInput(extra: Partial<LotHoldInput> = {}): LotHoldInput {
  return { lotId: 1n, reasonCode: 'SUSPECT_MATERIAL', ...extra };
}

/** 이미 열려 있는 보류 한 행 — 잔량 행이 베낄 칸을 다 갖춘다. */
function openRow(extra: Partial<LotHoldRow> = {}): LotHoldRow {
  return {
    lot_hold_id: 41n,
    lot_id: 1n,
    hold_qty: dec('10'),
    uom_id: 3n,
    reason_code: HELD_REASON,
    release_condition: '재검 합격',
    status_code: 'HELD',
    held_by: 2n,
    held_at: new Date('2026-09-01T00:00:00Z'),
    released_by: null,
    released_at: null,
    remarks: '처음 걸 때',
    created_at: new Date('2026-09-01T00:00:00Z'),
    created_by: 2n,
    release_reason_code: null,
    target_lot_status_code: 'DEFECTIVE',
    release_target_lot_status_code: null,
    version_no: 1,
    ...extra,
  } as LotHoldRow;
}

describe('LotHoldService', () => {
  const service = new LotHoldService();

  it('⭐⭐ R-5 — lot 잠금이 보류 쓰기보다 «먼저»고, 한 문장에 id 오름차순이다', async () => {
    const { tx, calls, args } = fake([1n, 2n]);

    const locked = await service.lockLotsWithin(tx, [2n, 1n]);
    await service.holdWithin(tx, locked, [holdInput()], ACTOR);

    expect(calls).toEqual(['lot.lock', 'lot_hold.create']);
    const sql = args[0].sql as string;
    expect(sql).toContain('FROM trace.lot\n');
    // ⭐ 방향까지 못 박는다 — 형제 잠금(`lot-quality-status.service.ts:70`)이 «오름차순»이라
    //    여기만 DESC 가 되면 ④ 의 한 트랜잭션에서 두 질의가 같은 두 LOT 을 반대 순서로 잡아
    //    교착한다. 꼬리를 `$` 로 닫아 `SKIP LOCKED`(경합 LOT 을 조용히 빠뜨린다)도 함께 막는다.
    expect(sql).toMatch(/ORDER BY lot_id\s+FOR UPDATE\s*$/);
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
    const { tx, args } = fake([1n]);

    const locked: LockedLot[] = await service.lockLotsWithin(tx, [1n]);

    // ⭐ 가짜는 SQL 과 무관하게 세 칸을 돌려주므로 반환값 단언만으로는 아무것도 못 잠근다.
    //    ③b §3-2 b 와 ④ §3-1 b 의 409(`currentVersion`·`currentLotStatusCode`)가 이 두 칸에
    //    기댄다 — SELECT 목록 자체를 못 박는다.
    expect(args[0].sql as string).toContain('SELECT lot_id, status_code, version_no');
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

  it('⭐⭐ R-5 — 재계수가 잠금 «안»이다(코어가 세어 돌려주므로 호출자가 밖으로 못 흘린다)', async () => {
    const { tx, calls } = fake([1n], [openRow()]);

    const locked = await service.lockLotsWithin(tx, [1n]);
    await service.releaseWithin(tx, locked, { lotId: 1n, reasonCode: HELD_REASON }, RELEASE, ACTOR);

    expect(calls).toEqual(['lot.lock', 'lot_hold.findMany', 'lot_hold.update', 'lot_hold.count']);
  });

  it('⭐⭐ R-5 — 잠그지 않은 LOT 은 풀지도 세지도 못한다', async () => {
    const { tx, calls } = fake([1n], [openRow()]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    await expect(service.releaseWithin(tx, locked, { lotId: 9n, reasonCode: HELD_REASON }, RELEASE, ACTOR)).rejects.toThrow('잠그지 않은 LOT');
    // 던지기 «전»에 읽지도 쓰지도 않았다.
    expect(calls).toEqual(['lot.lock']);
  });

  it('releaseWithin 이 원 행의 다섯 칸을 채운다(status_code·version_no 는 «안» 건드린다)', async () => {
    const { tx, args } = fake([1n], [openRow({ hold_qty: null })]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    const { released } = await service.releaseWithin(tx, locked, { lotId: 1n, reasonCode: HELD_REASON }, RELEASE, ACTOR);

    expect(args[2]).toMatchObject({ where: { lot_hold_id: 41n } });
    expect(args[2].data).toEqual({
      released_at: NOW,
      released_by: 7n,
      release_reason_code: 'RETEST_PASS',
      release_target_lot_status_code: 'NORMAL',
      remarks: '풀었다',
    });
    // ⛔ `LOT_HOLD_STATUS` 값 목록이 시드에 0건이라 이 축을 안 건드린다(문의 13).
    expect(args[2].data).not.toHaveProperty('status_code');
    // ⛔ R-24 — 죽은 칸이고 `plan.md` §6 이 다음 릴리스 `DROP COLUMN` 으로 못 박았다. 새 쓰기를
    //    더하면 그 삭제가 이 해제를 죽인다(`CLAUDE.md` 두 릴리스 규칙).
    expect(args[2].data).not.toHaveProperty('version_no');
    // 반환은 «update 뒤» 행이다 — ⑤ 가 재조회를 생략해도 응답의 releasedAt 이 NULL 로 안 나간다.
    expect(released[0].released_at).toEqual(NOW);
  });

  it('⭐ Major-1 — 입력이 두 칸을 «생략»하면 도착은 NULL 이고 원 행의 remarks 는 안 건드린다', async () => {
    const { tx, args } = fake([1n], [openRow()]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    // `:confirm` 이 실제로 타는 갈래다 — 둘 다 «안 준다».
    await service.releaseWithin(tx, locked, { lotId: 1n, reasonCode: HELD_REASON }, { releaseReasonCode: 'RETEST_PASS' }, ACTOR);

    // ⭐ R-2 — 안 움직였으면 도착을 비운다. 'NORMAL' 이 들어가면 `W-03-01` 이력의 「전이」 열에
    //    LOT 이 안 움직였는데도 「보류 → 정상」이 그려진다.
    expect(args[2].data).toHaveProperty('release_target_lot_status_code', null);
    // ⭐ 키를 «생략»해 원 행의 비고를 그대로 둔다 — NULL 로 덮으면 현장이 적은 비고가 사라진다.
    expect(args[2].data).not.toHaveProperty('remarks');
  });

  it('⭐ R-11 — 사유로 좁혀 풀고, 재계수는 «다른 사유»의 열린 보류를 함께 센다', async () => {
    const { tx, args } = fake(
      [1n],
      [
        openRow(),
        openRow({ lot_hold_id: 42n, reason_code: 'CLAIM' }),
        openRow({ lot_hold_id: 43n, released_at: new Date('2026-09-02T00:00:00Z') }),
      ],
    );
    const locked = await service.lockLotsWithin(tx, [1n]);

    const { released, openAfter } = await service.releaseWithin(
      tx,
      locked,
      { lotId: 1n, reasonCode: HELD_REASON },
      RELEASE,
      ACTOR,
    );

    // 43 은 이미 닫혀 안 걸린다 — 닫힌 행을 다시 닫으면 `released_at` 이 뒤로 밀린다.
    expect(released.map((r) => r.lot_hold_id)).toEqual([41n]);
    // 재계수가 사유를 가리면 0 이 되어 의심자재 보류가 열린 채 LOT 이 `NORMAL` 로 간다.
    expect(openAfter).toBe(1);
    expect(args[1].where).toEqual({ lot_id: 1n, released_at: null, reason_code: 'SUSPECT_MATERIAL' });
    expect(args[3].where).toEqual({ lot_id: 1n, released_at: null });
  });

  it('여러 건을 풀면 released 가 lot_hold_id 오름차순이다(호출자가 첫 건을 집는다)', async () => {
    // 씨앗을 «역순»으로 심는다 — `orderBy` 를 'desc' 로 뒤집으면 이 단언이 무너져야 한다.
    const { tx } = fake([1n], [openRow({ lot_hold_id: 44n }), openRow({ lot_hold_id: 42n })]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    const { released } = await service.releaseWithin(tx, locked, { lotId: 1n, reasonCode: HELD_REASON }, RELEASE, ACTOR);

    expect(released.map((r) => r.lot_hold_id)).toEqual([42n, 44n]);
  });

  it('lotHoldIds 로 좁히면 그 한 건만 푼다(`:release` 가 겨냥하는 모양)', async () => {
    const { tx, args } = fake([1n], [openRow(), openRow({ lot_hold_id: 42n })]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    const { released, openAfter } = await service.releaseWithin(
      tx,
      locked,
      { lotId: 1n, lotHoldIds: [42n] },
      RELEASE,
      ACTOR,
    );

    expect(released.map((r) => r.lot_hold_id)).toEqual([42n]);
    expect(openAfter).toBe(1);
    expect(args[1].where).toEqual({ lot_id: 1n, released_at: null, lot_hold_id: { in: [42n] } });
  });

  it('⭐⭐ R-6 — releaseQty 가 hold_qty 와 «같으면» 잔량 0 행을 만들지 않는다', async () => {
    // ⓐ 한계와 «같은» 값 — `app.qty_t` 가 `CHECK (VALUE >= 0)` 이라 0 짜리 행이 조용히 들어간다.
    // ⓑ 한계를 넘는 값(도메인이 400 으로 막지만 코어도 음수 잔량을 안 만든다).
    // ⓒ 전량 보류(`hold_qty` NULL)에서는 뺄 것이 없다.
    const cases: [Prisma.Decimal | null, string][] = [
      [dec('10'), '10'],
      [dec('10'), '11'],
      [null, '3'],
    ];
    for (const [holdQty, releaseQty] of cases) {
      const { tx, calls } = fake([1n], [openRow({ hold_qty: holdQty })]);
      const locked = await service.lockLotsWithin(tx, [1n]);

      const { openAfter } = await service.releaseWithin(
        tx,
        locked,
        { lotId: 1n, reasonCode: HELD_REASON },
        { ...RELEASE, releaseQty: dec(releaseQty) },
        ACTOR,
      );

      expect(calls).toEqual(['lot.lock', 'lot_hold.findMany', 'lot_hold.update', 'lot_hold.count']);
      // 잔량 0 행이 서면 여기가 1 이 되고 — 전량을 풀었는데 LOT 이 영영 안 움직인다.
      expect(openAfter).toBe(0);
    }
  });

  it('부분 해제는 잔량 행을 세우고 held_by·held_at 이 «지금·이 사람»이다(문의 079)', async () => {
    const { tx, calls, args } = fake([1n], [openRow()]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    const { openAfter } = await service.releaseWithin(
      tx,
      locked,
      { lotId: 1n, reasonCode: HELD_REASON },
      { ...RELEASE, releaseQty: dec('4') },
      ACTOR,
    );

    expect(calls).toEqual(['lot.lock', 'lot_hold.findMany', 'lot_hold.update', 'lot_hold.create', 'lot_hold.count']);
    expect(args[3].data).toMatchObject({
      lot_id: 1n,
      hold_qty: dec('6'),
      reason_code: 'SUSPECT_MATERIAL',
      status_code: 'HELD',
      uom_id: 3n,
      release_condition: '재검 합격',
      target_lot_status_code: 'DEFECTIVE',
      // 사유·조건·도착·비고는 「같은 보류의 나머지」라 원 행에서 그대로 물려받는다.
      remarks: '처음 걸 때',
      held_by: 7n,
      held_at: NOW,
      created_by: 7n,
    });
    // 잔량 행은 열려 있다 — 그래서 부분 해제는 LOT 을 못 옮긴다(§3-2 f · 필연이지 결론이 아니다).
    expect(args[3].data).not.toHaveProperty('released_at');
    expect(openAfter).toBe(1);
  });

  it('⛔ 보류 두 건을 한 번에 부분 해제하지 못한다 — 어느 행에서 뺄지가 없다', async () => {
    const { tx } = fake([1n], [openRow(), openRow({ lot_hold_id: 42n })]);
    const locked = await service.lockLotsWithin(tx, [1n]);

    await expect(
      service.releaseWithin(tx, locked, { lotId: 1n, reasonCode: HELD_REASON }, { ...RELEASE, releaseQty: dec('1') }, ACTOR),
    ).rejects.toThrow('대상 2건');
  });
});
