import { InputRow, inputWindows, lotsAt, lotsBetween } from './lot-genealogy';

const at = (hour: number) => new Date(Date.UTC(2026, 9, 22, hour));
const input = (id: number, item: number, lot: number, hour: number, corrects: number | null = null): InputRow => ({
  material_consumption_id: BigInt(id),
  item_id: BigInt(item),
  lot_id: BigInt(lot),
  occurred_at: at(hour),
  corrects_consumption_id: corrects === null ? null : BigInt(corrects),
});
const lots = (windows: { lotId: bigint }[]) => windows.map((w) => Number(w.lotId));

describe('투입 시각 기준 계보 (omf-all-around#166)', () => {
  it('다른 LOT 이 들어온 시각에 앞 LOT 을 끊고, 같은 LOT 재투입은 구간을 잇는다', () => {
    const windows = inputWindows([input(1, 41, 77, 1), input(2, 41, 77, 2), input(3, 41, 78, 4)]);

    expect(windows).toEqual([
      { itemId: 41n, lotId: 77n, from: at(1), to: at(4) },
      { itemId: 41n, lotId: 78n, from: at(4), to: null },
    ]);
  });

  it('자재 품목마다 따로 끊는다 — 다른 자재 투입은 구간을 끊지 않는다', () => {
    const windows = inputWindows([input(1, 41, 77, 1), input(2, 42, 90, 2)]);

    expect(lots(lotsAt(windows, at(3)))).toEqual([77, 90]);
  });

  it('입력 순서와 무관하게 시각순이다(지연 입력)', () => {
    const windows = inputWindows([input(2, 41, 78, 4), input(1, 41, 77, 1)]);

    expect(lots(lotsAt(windows, at(2)))).toEqual([77]);
    expect(lots(lotsAt(windows, at(5)))).toEqual([78]);
  });

  it('정정된 원 투입은 뺀다', () => {
    const windows = inputWindows([input(1, 41, 77, 1), input(2, 41, 78, 1, 1)]);

    expect(lots(windows)).toEqual([78]);
  });

  it('실적 구간 안에서 LOT 이 바뀌었으면 둘 다 잇는다(교체 중 겹침)', () => {
    const windows = inputWindows([input(1, 41, 77, 1), input(2, 41, 78, 3)]);

    expect(lots(lotsBetween(windows, at(2), at(4)))).toEqual([77, 78]);
    expect(lots(lotsBetween(windows, at(3), at(4)))).toEqual([78]);
    expect(lots(lotsBetween(windows, null, at(2)))).toEqual([77]);
  });

  it('실적보다 늦게 투입한 LOT 은 잇지 않는다', () => {
    const windows = inputWindows([input(1, 41, 77, 5)]);

    expect(lotsBetween(windows, null, at(4))).toEqual([]);
  });

  it('시리얼 — 생산 시각에 쓰던 LOT 하나, 정확히 교체 시각이면 둘 다', () => {
    const windows = inputWindows([input(1, 41, 77, 1), input(2, 41, 78, 3)]);

    expect(lots(lotsAt(windows, at(2)))).toEqual([77]);
    expect(lots(lotsAt(windows, at(3)))).toEqual([77, 78]);
    expect(lotsAt(windows, at(0))).toEqual([]);
  });
});
