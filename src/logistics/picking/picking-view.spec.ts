import { RankLine, pickSequenceRanks } from './picking-view';

/** 라인 하나 — 순위는 `shelf_life_days`·`expiry_date`·`manufactured_at` 셋으로만 갈린다. */
function line(
  pickingLineId: number,
  itemId: number,
  lineNo: number,
  shelfLifeDays: number | null,
  lot: { expiry?: string | null; manufactured?: string | null } = {},
): RankLine {
  return {
    picking_line_id: BigInt(pickingLineId),
    item_id: BigInt(itemId),
    line_no: lineNo,
    item: { shelf_life_days: shelfLifeDays },
    lot: {
      expiry_date: lot.expiry === undefined || lot.expiry === null ? null : new Date(lot.expiry),
      manufactured_at:
        lot.manufactured === undefined || lot.manufactured === null
          ? null
          : new Date(lot.manufactured),
    },
  };
}

describe('pickSequenceRanks — 라인의 선출 순위', () => {
  it('pickSequenceRank 는 유효기한 품목에서 FEFO 로 매긴다', () => {
    const ranks = pickSequenceRanks([
      line(11, 7, 1, 365, { expiry: '2027-07-31' }),
      line(12, 7, 2, 365, { expiry: '2026-12-31' }),
    ]);

    // 먼저 만료되는 LOT 이 1순위다 — 라인 번호 순서가 아니다.
    expect(ranks.get(12n)).toBe(1);
    expect(ranks.get(11n)).toBe(2);
  });

  it('정렬 키가 널이면 순위가 널이다', () => {
    const ranks = pickSequenceRanks([
      line(21, 7, 1, 365, { expiry: null }),
      line(22, 7, 2, 365, { expiry: '2026-12-31' }),
    ]);

    // 계약 ⌜정렬 근거가 없으면 비어 온다 — 「1순위」가 아니다⌝ · 키 생략이 아니라 널(R-20).
    expect(ranks.get(21n)).toBeNull();
    // 키가 널인 라인은 순위 매김에서 빠지므로 남은 하나가 1순위다.
    expect(ranks.get(22n)).toBe(1);
  });

  it('유효기한 없는 품목은 manufactured_at 으로 FIFO 다', () => {
    const ranks = pickSequenceRanks([
      line(31, 8, 1, null, { manufactured: '2026-08-01T00:00:00.000Z', expiry: '2026-01-01' }),
      line(32, 8, 2, null, { manufactured: '2026-07-01T00:00:00.000Z' }),
    ]);

    // `shelf_life_days` 가 널이면 `expiry_date` 가 있어도 안 본다 — 품목이 FIFO 다(R-21).
    expect(ranks.get(32n)).toBe(1);
    expect(ranks.get(31n)).toBe(2);
  });

  it('순위는 품목마다 따로 매기고 동률은 line_no 로 가른다', () => {
    const ranks = pickSequenceRanks([
      line(41, 7, 1, 365, { expiry: '2026-12-31' }),
      line(42, 9, 2, 365, { expiry: '2027-01-31' }),
      line(43, 7, 3, 365, { expiry: '2026-12-31' }),
    ]);

    expect(ranks.get(42n)).toBe(1);
    expect(ranks.get(41n)).toBe(1);
    expect(ranks.get(43n)).toBe(2);
  });
});
