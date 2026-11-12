import { aqlPlan } from './aql';

describe('aqlPlan — KS Q ISO 2859-1 보통 검사 1회 샘플링(omf-all-around#264)', () => {
  it.each([
    // LOT 501~1200 · G-II → J(80)
    [1000, 'G-II', 0.65, { codeLetter: 'J', sampleSize: 80, acceptanceNumber: 1, rejectionNumber: 2 }],
    [1000, 'G-II', 1.5, { codeLetter: 'J', sampleSize: 80, acceptanceNumber: 3, rejectionNumber: 4 }],
    [1000, 'G-II', 2.5, { codeLetter: 'J', sampleSize: 80, acceptanceNumber: 5, rejectionNumber: 6 }],
    [1000, 'G-II', 4, { codeLetter: 'J', sampleSize: 80, acceptanceNumber: 7, rejectionNumber: 8 }],
    // ↓ — J · 0.4 칸은 아래 K(125)의 계획을 쓴다
    [770, 'G-II', 0.4, { codeLetter: 'J', sampleSize: 125, acceptanceNumber: 1, rejectionNumber: 2 }],
    // ↓ 여러 칸 — F · 0.4 는 G(32) 의 0/1
    [100, 'G-II', 0.4, { codeLetter: 'F', sampleSize: 32, acceptanceNumber: 0, rejectionNumber: 1 }],
    // ↑ — F · 1.0 은 위 E(13) 의 0/1
    [100, 'G-II', 1, { codeLetter: 'F', sampleSize: 13, acceptanceNumber: 0, rejectionNumber: 1 }],
    [3200, 'G-II', 1, { codeLetter: 'K', sampleSize: 125, acceptanceNumber: 3, rejectionNumber: 4 }],
    [600000, 'G-III', 0.65, { codeLetter: 'R', sampleSize: 2000, acceptanceNumber: 21, rejectionNumber: 22 }],
    // ↑ 끝 — R · 1.0 은 Q(1250) 의 21/22 (LOT 50만 초과 · G-III → R)
    [600000, 'G-III', 1, { codeLetter: 'R', sampleSize: 1250, acceptanceNumber: 21, rejectionNumber: 22 }],
    // A · 10 은 ↓(위가 없다) — B · 10 도 ↓ 라 C(5) 의 1/2. LOT 5 면 전수
    [8, 'G-II', 10, { codeLetter: 'A', sampleSize: 5, acceptanceNumber: 1, rejectionNumber: 2 }],
    [5, 'G-II', 10, { codeLetter: 'A', sampleSize: 5, acceptanceNumber: 1, rejectionNumber: 2 }],
    // ↑ — B · 6.5 는 위 A(2) 의 0/1
    [12, 'G-II', 6.5, { codeLetter: 'B', sampleSize: 2, acceptanceNumber: 0, rejectionNumber: 1 }],
    // R · 0.015 는 ↑(아래가 없다) — Q · 0.015 도 ↑ 라 P(800) 의 0/1
    [600000, 'G-III', 0.015, { codeLetter: 'R', sampleSize: 800, acceptanceNumber: 0, rejectionNumber: 1 }],
    // 특별 검사 수준 — LOT 770 · S-3 → E(13)
    [770, 'S-3', 1, { codeLetter: 'E', sampleSize: 13, acceptanceNumber: 0, rejectionNumber: 1 }],
  ])('LOT %d · %s · AQL %d', (lot, level, aql, expected) => {
    expect(aqlPlan(lot, level, aql)).toEqual(expected);
  });

  it('시료 수가 LOT 이상이면 LOT 수량만 검사한다(전수)', () => {
    expect(aqlPlan(10, 'G-II', 0.4)).toEqual({
      codeLetter: 'B',
      sampleSize: 10,
      acceptanceNumber: 0,
      rejectionNumber: 1,
    });
  });

  it('표에 없는 AQL · 검사 수준이거나 LOT 이 1 미만이면 계산하지 않는다', () => {
    expect(aqlPlan(1000, 'G-II', 0)).toBeNull();
    expect(aqlPlan(1000, 'G-II', 15)).toBeNull();
    expect(aqlPlan(1000, 'X', 1)).toBeNull();
    expect(aqlPlan(0, 'G-II', 1)).toBeNull();
  });
});
