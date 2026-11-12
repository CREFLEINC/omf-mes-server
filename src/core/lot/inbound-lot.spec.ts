import { inboundLineLotSql, lotsOfInboundLines, representativeLot } from './inbound-lot';

/** 피처 005 — 입하 줄 ↔ 자재 LOT. 새 흐름의 줄(`lot_id` 없음)은 원천 LOT 전부, 옛 줄은 `lot_id` 하나. */
describe('inbound-lot', () => {
  const db = (rows: Record<string, unknown>[]) => {
    const findMany = jest.fn().mockResolvedValue(rows);
    return { db: { lot: { findMany } } as never, findMany };
  };
  const sourced = (lotId: bigint, lineId: bigint, lotNo: string) => ({
    lot_id: lotId, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: lineId, lot_no: lotNo,
  });

  it('새 흐름의 줄은 원천 LOT 을 lot_id 오름차순으로 모으고, LOT 이 없는 줄은 빈 배열이다', async () => {
    const { db: client, findMany } = db([sourced(5n, 10n, 'A'), sourced(7n, 10n, 'B'), sourced(9n, 11n, 'C')]);
    const lines = [10n, 11n, 12n].map((id) => ({ inbound_receipt_line_id: id, lot_id: null }));

    const byLine = await lotsOfInboundLines(client, lines, { lot_no: true });

    expect(findMany).toHaveBeenCalledWith({
      where: { OR: [{ source_type_code: 'INBOUND_RECEIPT_LINE', source_id: { in: [10n, 11n, 12n] } }] },
      select: { lot_no: true, lot_id: true, source_type_code: true, source_id: true },
      orderBy: { lot_id: 'asc' },
    });
    expect(byLine.get(10n)?.map((lot) => lot.lot_no)).toEqual(['A', 'B']);
    expect(byLine.get(11n)?.map((lot) => lot.lot_id)).toEqual([9n]);
    expect(byLine.get(12n)).toEqual([]);
  });

  it('옛 줄(lot_id 있음)은 그 LOT 하나뿐이다 — 같은 줄을 원천으로 한 다른 LOT 이나 원천이 다른 LOT 이어도', async () => {
    const { db: client, findMany } = db([{ ...sourced(58n, 1n, 'OLD'), source_id: 99n }, sourced(60n, 2n, 'NEW')]);

    const byLine = await lotsOfInboundLines(
      client,
      [
        { inbound_receipt_line_id: 1n, lot_id: 58n },
        { inbound_receipt_line_id: 2n, lot_id: null },
      ],
      { lot_no: true },
    );

    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [{ lot_id: { in: [58n] } }, { source_type_code: 'INBOUND_RECEIPT_LINE', source_id: { in: [2n] } }],
    });
    expect(byLine.get(1n)?.map((lot) => lot.lot_no)).toEqual(['OLD']);
    expect(byLine.get(2n)?.map((lot) => lot.lot_no)).toEqual(['NEW']);
  });

  it('줄이 없으면 조회하지 않는다', async () => {
    const { db: client, findMany } = db([]);

    expect(await lotsOfInboundLines(client, [], {})).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });

  it('대표 LOT 은 맨 앞이다 — 없으면 null', () => {
    expect(representativeLot([{ lot_id: 5n }, { lot_id: 7n }])).toEqual({ lot_id: 5n });
    expect(representativeLot([])).toBeNull();
    expect(representativeLot(undefined)).toBeNull();
  });

  it('SQL 연결 조건 — 줄의 lot_id 가 있으면 그것, 없으면 원천으로 잇는다', () => {
    expect(inboundLineLotSql('lt', 'irl').replace(/\s+/g, ' ')).toBe(
      `(irl.lot_id = lt.lot_id OR (irl.lot_id IS NULL AND lt.source_type_code = 'INBOUND_RECEIPT_LINE' AND lt.source_id = irl.inbound_receipt_line_id))`,
    );
  });
});
