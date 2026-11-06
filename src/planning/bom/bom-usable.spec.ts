import { REVISION_STATUS } from '../revision-status';
import { usableWhere } from './bom.service';

/** BOM 후보의 「오늘」 — 현장 시간대의 현지 날짜다(omf-all-around#238). */
describe('BOM usableWhere', () => {
  afterEach(() => jest.useRealTimers());

  it('확정이고 그 날짜가 유효 기간 안인 개정이다', () => {
    const today = new Date('2026-11-05');
    expect(usableWhere('2026-11-05')).toEqual({
      status_code: REVISION_STATUS.CONFIRMED,
      AND: [{ effective_from: { lte: today } }, { OR: [{ effective_to: null }, { effective_to: { gte: today } }] }],
    });
  });

  it('기본값은 현장 시간대의 오늘이다 — UTC 20:00 이면 현지는 이튿날이다', () => {
    jest.useFakeTimers({ now: new Date('2026-11-04T20:00:00.000Z') });
    expect(usableWhere()).toEqual(usableWhere('2026-11-05'));
  });
});
