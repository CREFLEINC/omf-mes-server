import { pickCurrentLot } from './lot-rules';

const lot = (lot_id: bigint, lifecycle_status_code: string, work_order_lot_seq: number | null) => ({
  lot_id,
  lifecycle_status_code,
  work_order_lot_seq,
});

describe('현재 생산 LOT 고르기', () => {
  it('진행 중 LOT 이 있으면 대기 중보다 먼저 고른다', () => {
    expect(pickCurrentLot([lot(1n, 'WAITING', 1), lot(2n, 'ACTIVE', 2)])?.lot_id).toBe(2n);
  });

  it('같은 상태면 회차가 가장 앞선 LOT 을 고른다 — 회차 없는 LOT 은 뒤', () => {
    expect(pickCurrentLot([lot(5n, 'WAITING', null), lot(4n, 'WAITING', 3), lot(3n, 'WAITING', 2)])?.lot_id).toBe(3n);
  });

  it('진행 중이 둘 이상이어도 막지 않고 회차가 가장 앞선 것을 고른다', () => {
    expect(pickCurrentLot([lot(7n, 'ACTIVE', 2), lot(6n, 'ACTIVE', 1)])?.lot_id).toBe(6n);
  });

  it('후보가 없으면 없다', () => {
    expect(pickCurrentLot([])).toBeUndefined();
  });
});
