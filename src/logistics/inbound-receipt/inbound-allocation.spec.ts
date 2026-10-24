import { Prisma } from '@prisma/client';

import { ERROR_CODE } from '../../common/errors';
import { AllocationLine, AllocationTarget, allocationTargetError, unallocatedQtyOf } from './inbound-allocation';

const d = (value: number) => new Prisma.Decimal(value);

const LINE: AllocationLine = { item_id: 40n, uom_id: 50n, inbound_receipt: { plant_id: 30n, supplier_id: 10n } };

const target = (overrides: Partial<AllocationTarget> = {}): AllocationTarget => ({
  item_id: 40n,
  uom_id: 50n,
  cancelled_at: null,
  ordered_qty: d(100),
  tolerance_over_qty: d(0),
  received_qty: d(0),
  purchase_order: { plant_id: 30n, supplier_id: 10n, status_code: 'CONFIRMED' },
  ...overrides,
});

describe('unallocatedQtyOf — 미배정은 받은 수량 − 배정 합', () => {
  it('배정이 없으면 받은 수량 전체다(무발주 줄)', () => {
    expect(unallocatedQtyOf(d(5000), []).toString()).toBe('5000');
  });

  it('배정 합을 뺀다 — 4,500 + 300 배정이면 200 이 남는다', () => {
    expect(unallocatedQtyOf(d(5000), [{ allocated_qty: d(4500) }, { allocated_qty: d(300) }]).toString()).toBe('200');
  });

  it('끝자리까지 Decimal 로 센다', () => {
    expect(unallocatedQtyOf(d(1), [{ allocated_qty: new Prisma.Decimal('0.000001') }]).toString()).toBe('0.999999');
  });
});

describe('allocationTargetError — 배정할 수 있는 P/O 라인', () => {
  it('같은 공장·공급사·품목·단위의 살아 있는 라인이면 된다', () => {
    expect(allocationTargetError(LINE, target(), 'purchaseOrderLineId')).toBeNull();
  });

  it.each([
    ['품목', { item_id: 41n }],
    ['단위', { uom_id: 51n }],
    ['공장', { purchase_order: { plant_id: 31n, supplier_id: 10n, status_code: 'CONFIRMED' } }],
    ['공급사', { purchase_order: { plant_id: 30n, supplier_id: 11n, status_code: 'CONFIRMED' } }],
  ])('%s 이 다르면 INVALID 다', (_name, overrides) => {
    expect(allocationTargetError(LINE, target(overrides), 'purchaseOrderLineId')).toMatchObject({
      field: 'purchaseOrderLineId',
      code: ERROR_CODE.INVALID,
      message: '같은 공장·공급사·품목·단위의 P/O 라인이어야 합니다.',
    });
  });

  it('ERP 가 취소한 라인은 INVALID 다', () => {
    expect(allocationTargetError(LINE, target({ cancelled_at: new Date() }), 'at')).toMatchObject({
      field: 'at',
      code: ERROR_CODE.INVALID,
      message: '취소했거나 닫힌 P/O 라인입니다.',
    });
  });

  it.each(['CLOSED', 'CANCELLED'])('헤더가 %s 인 발주의 라인은 INVALID 다', (status_code) => {
    const closed = target({ purchase_order: { plant_id: 30n, supplier_id: 10n, status_code } });
    expect(allocationTargetError(LINE, closed, 'at')).toMatchObject({ code: ERROR_CODE.INVALID });
  });

  it('조건이 맞으면 발주 한도를 여기서 보지 않는다 — 한도는 add 가 Decimal 로 따로 본다', () => {
    expect(allocationTargetError(LINE, target({ received_qty: d(100) }), 'at')).toBeNull();
  });
});
