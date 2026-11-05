import { Prisma } from '@prisma/client';

import { pairKey } from './planned-stock';
import { ReplenishmentLine, planLines, sourceGroups } from './replenishment-create';

const d = (value: number) => new Prisma.Decimal(value);
const line = (itemId: bigint, qty: number, source: bigint): ReplenishmentLine => ({ itemId, uomId: 1n, requestedQty: d(qty), sourceWarehouseId: source });
const qty = (rows: { line: ReplenishmentLine; requested: Prisma.Decimal; shortage: Prisma.Decimal }[]) =>
  rows.map((r) => [r.line.itemId, r.line.sourceWarehouseId, r.requested.toNumber(), r.shortage.toNumber()]);

// 출고 자재 창고 M(1)·N(2), 품목 X(10)·Y(11)·Z(12).
describe('창고 보충 요청 만들기 — 상한·분할 (피처 004)', () => {
  it('출고 자재 창고별로 묶는다 — 창고 번호 순, 중복 없음(FR-007)', () => {
    expect(sourceGroups([line(10n, 1, 2n), line(11n, 1, 1n), line(12n, 1, 2n)])).toEqual([1n, 2n]);
  });

  it('쓸 수 있는 양 = 가용 − 예정 — 요청은 그만큼, 넘는 양은 부족(US1-6)', () => {
    const available = new Map([[pairKey(1n, 10n), d(100)]]);
    const planned = new Map([[pairKey(1n, 10n), d(60)]]);
    const { kept, skipped } = planLines([line(10n, 100, 1n)], available, planned);
    expect(qty(kept)).toEqual([[10n, 1n, 40, 60]]);
    expect(kept[0].freeQty.toNumber()).toBe(40);
    expect(skipped).toEqual([]);
  });

  it('쓸 수 있는 양 이내면 그대로, 부족 0', () => {
    const { kept } = planLines([line(10n, 30, 1n)], new Map([[pairKey(1n, 10n), d(100)]]), new Map());
    expect(qty(kept)).toEqual([[10n, 1n, 30, 0]]);
  });

  it('쓸 수 있는 양이 0 이하인 줄은 건너뛴다 — 예정이 가용을 넘어도 음수로 깎지 않는다(US1-7)', () => {
    const available = new Map([[pairKey(1n, 10n), d(50)], [pairKey(2n, 11n), d(20)]]);
    const planned = new Map([[pairKey(1n, 10n), d(80)]]);
    const { kept, skipped } = planLines([line(10n, 10, 1n), line(11n, 5, 2n), line(12n, 5, 2n)], available, planned);
    expect(qty(kept)).toEqual([[11n, 2n, 5, 0]]);
    expect(skipped.map((s) => [s.line.itemId, s.freeQty.toNumber()])).toEqual([[10n, 0], [12n, 0]]);
  });

  it('모든 줄이 0 이면 만든 줄이 없다 — 부르는 쪽이 409 를 낸다', () => {
    const { kept, skipped } = planLines([line(10n, 10, 1n)], new Map(), new Map());
    expect(kept).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it('같은 쌍이 두 줄이면 앞 줄이 먼저 쓰고 뒤 줄은 남은 만큼', () => {
    const { kept, skipped } = planLines([line(10n, 30, 1n), line(10n, 30, 1n)], new Map([[pairKey(1n, 10n), d(40)]]), new Map());
    expect(qty(kept)).toEqual([[10n, 1n, 30, 0], [10n, 1n, 10, 20]]);
    expect(skipped).toEqual([]);
  });
});
