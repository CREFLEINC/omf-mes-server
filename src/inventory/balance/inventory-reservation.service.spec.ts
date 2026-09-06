import { reservationWhere } from './inventory-reservation.service';

describe('재고 예약 목록', () => {
  it('openOnly 는 reserved − released − consumed > 0 으로 거른다', () => {
    // 「아직 소진되지 않은 예약」은 상태 문자열이 아니라 수량 축이다(계약 `x-no-code-key`).
    const open = reservationWhere({ openOnly: 'true' });
    expect(open.text).toContain('reserved_qty - released_qty - consumed_qty > 0');

    expect(reservationWhere({}).text).not.toContain('consumed_qty');
    expect(reservationWhere({ openOnly: 'false' }).text).not.toContain('consumed_qty');
  });

  it('질의 칸은 파라미터로 나간다', () => {
    const where = reservationWhere({ itemId: '10', warehouseId: 3, statusCode: 'OPEN' });

    expect(where.text).toContain('item_id = $1');
    expect(where.values).toEqual([10n, 3n, 'OPEN']);
  });
});
