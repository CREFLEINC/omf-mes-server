import { Prisma } from '@prisma/client';

import { withoutEmptyBalances } from './balance-lock';

const row = (status: string, onHand: number) => ({
  inventory_status_code: status,
  on_hand_qty: new Prisma.Decimal(onHand),
});

describe('withoutEmptyBalances (#233)', () => {
  it('2행+ 면 보유 0 행을 뺀다', () => {
    expect(withoutEmptyBalances([row('IN_TRANSIT', 0), row('AVAILABLE', 500)])).toEqual([row('AVAILABLE', 500)]);
  });

  it('보유가 있는 행이 둘이면 둘 다 남긴다(문의 031)', () => {
    expect(withoutEmptyBalances([row('IN_TRANSIT', 5), row('AVAILABLE', 500)])).toHaveLength(2);
  });

  it('1행이면 보유 0 이어도 그대로다', () => {
    expect(withoutEmptyBalances([row('AVAILABLE', 0)])).toEqual([row('AVAILABLE', 0)]);
  });

  it('전부 보유 0 이면 그대로다', () => {
    expect(withoutEmptyBalances([row('IN_TRANSIT', 0), row('AVAILABLE', 0)])).toHaveLength(2);
  });

  it('음수 보유는 빈 행이 아니다', () => {
    expect(withoutEmptyBalances([row('AVAILABLE', -3), row('IN_TRANSIT', 0)])).toEqual([row('AVAILABLE', -3)]);
  });
});
