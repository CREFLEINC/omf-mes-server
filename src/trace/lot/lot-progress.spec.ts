import { Prisma } from '@prisma/client';

import { lotProgress } from './lot-progress';

const decimal = (value: number) => new Prisma.Decimal(value);

describe('LOT 진척 판정 (I-7 PR ④)', () => {
  it('진척 — `completionJudgmentCode` 는 누적<목표 `UNDER` · = `NORMAL` · > `OVER` 이고 `:complete` 의 미달 판정과 같은 함수다(R-6)', () => {
    // ⭐ `:complete` 가 부르는 함수와 «같은» 것이다 — 갈리면 완료 화면이 미달이라 그린 LOT 이
    //    서버에선 정상으로 통과한다(공유계약 L-2).
    expect(lotProgress(decimal(50), decimal(49.999999)).completionJudgmentCode).toBe('UNDER');
    expect(lotProgress(decimal(50), decimal(50)).completionJudgmentCode).toBe('NORMAL');
    expect(lotProgress(decimal(50), decimal(50.000001)).completionJudgmentCode).toBe('OVER');
    // 나머지 세 칸도 같은 호출이 함께 낸다 — 화면이 두 번 부르지 않는다.
    expect(lotProgress(decimal(50), decimal(30))).toMatchObject({
      goodQty: 30,
      achievementRate: 0.6,
      varianceQty: -20,
    });
  });

  it('진척 — `achievementRate` 는 `initialQty` 가 분모이고 0 이면 키를 생략한다', () => {
    // ⚠ W/O 진행의 달성률과 «분모가 다르다» — 그쪽은 W/O 지시 수량이다(계약 설명).
    expect(lotProgress(decimal(40), decimal(30)).achievementRate).toBe(0.75);
    // 나눌 수 없는 값을 지어내지 않는다 — 키 자체가 없다(공유계약 F-6).
    const zero = lotProgress(decimal(0), decimal(10));
    expect(Object.keys(zero)).not.toContain('achievementRate');
    expect(zero).toMatchObject({ goodQty: 10, varianceQty: 10, completionJudgmentCode: 'OVER' });
  });
});
