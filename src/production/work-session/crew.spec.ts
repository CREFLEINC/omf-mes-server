import { Prisma } from '@prisma/client';

import { overlapMs, participatedMinutes, splitQuantities, workerShares } from './crew';

const at = (hhmm: string) => new Date(`2026-09-07T${hhmm}:00.000Z`);
const D = (value: number | string) => new Prisma.Decimal(value);

describe('crew — 참여 시간', () => {
  it('겹침은 반열림 구간이고, 떠나지 않았으면 끝까지다', () => {
    expect(overlapMs(at('01:00'), at('02:00'), at('01:30'), at('03:00'))).toBe(30 * 60_000);
    expect(overlapMs(at('01:00'), null, at('01:30'), at('03:00'))).toBe(90 * 60_000);
    expect(overlapMs(at('04:00'), null, at('01:30'), at('03:00'))).toBe(0);
  });

  it('참여 분은 떠난 시각 → 세션 종료 → 지금 순으로 끝을 잡는다', () => {
    expect(participatedMinutes(at('01:00'), at('01:20'), at('02:00'), at('03:00'))).toBe(20);
    expect(participatedMinutes(at('01:00'), null, at('02:00'), at('03:00'))).toBe(60);
    expect(participatedMinutes(at('01:00'), null, null, at('03:00'))).toBe(120);
  });
});

describe('crew — 실적 배분', () => {
  const main = { workerId: 1n, roleCode: 'MAIN', joinedAt: at('01:00'), leftAt: null };

  it('참여 시간 비율로 나누고, 같은 사람의 재참여 구간을 합치며 주작업자가 맨 앞이다', () => {
    const shares = workerShares(
      [
        { workerId: 2n, roleCode: 'SUB', joinedAt: at('01:00'), leftAt: at('01:30') },
        main,
        { workerId: 2n, roleCode: 'SUB', joinedAt: at('02:30'), leftAt: null },
      ],
      at('01:00'),
      at('03:00'),
    );
    expect(shares.map((share) => [share.workerId, share.participatedMinutes, share.ratio.toString()])).toEqual([
      [1n, 120, '0.6666666667'],
      [2n, 60, '0.3333333333'],
    ]);
  });

  it('참여 시간이 모두 0 이면 주작업자가 전부다 — 몫이 0 인 사람은 빠진다', () => {
    const shares = workerShares([{ workerId: 2n, roleCode: 'SUB', joinedAt: at('05:00'), leftAt: null }, { ...main, joinedAt: at('05:00') }], at('01:00'), at('03:00'));
    expect(shares.map((share) => [share.workerId, share.ratio.toNumber()])).toEqual([[1n, 1]]);
  });

  it('구간에 일하지 않은 사람은 빠진다', () => {
    const shares = workerShares([main, { workerId: 2n, roleCode: 'SUB', joinedAt: at('00:00'), leftAt: at('00:30') }], at('01:00'), at('03:00'));
    expect(shares.map((share) => share.workerId)).toEqual([1n]);
  });

  it('주작업자가 없는 옛 세션은 먼저 참여한 사람이 맨 앞이다', () => {
    const shares = workerShares(
      [{ workerId: 3n, roleCode: 'OPERATOR', joinedAt: at('01:30'), leftAt: null }, { workerId: 4n, roleCode: 'OPERATOR', joinedAt: at('01:00'), leftAt: null }],
      at('01:00'),
      at('03:00'),
    );
    expect(shares[0].workerId).toBe(4n);
  });

  it('끝전은 몫이 가장 큰 사람에게 — 반올림이 넘쳐도 아무도 음수가 되지 않는다', () => {
    const parts = splitQuantities({ good_qty: D(1) }, [{ ratio: D('0.1666666667') }, { ratio: D('0.1666666667') }, { ratio: D('0.6666666667') }]);
    expect(parts.map((part) => part.good_qty.toString())).toEqual(['0.166667', '0.166667', '0.666666']);
  });

  it('수량을 소수 여섯째 자리로 나누고 끝전은 동률이면 맨 앞(주작업자)에게 — 합이 원래 수량과 같다', () => {
    const parts = splitQuantities({ good_qty: D(100), defect_qty: D(1) }, [{ ratio: D('0.3333333333') }, { ratio: D('0.3333333333') }, { ratio: D('0.3333333333') }]);
    expect(parts.map((part) => part.good_qty.toString())).toEqual(['33.333334', '33.333333', '33.333333']);
    expect(parts[0].good_qty.plus(parts[1].good_qty).plus(parts[2].good_qty).toString()).toBe('100');
    expect(parts.map((part) => part.defect_qty.toString())).toEqual(['0.333334', '0.333333', '0.333333']);
  });
});
