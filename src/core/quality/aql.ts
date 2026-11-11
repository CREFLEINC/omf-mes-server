/**
 * AQL 샘플링(omf-all-around#264) — KS Q ISO 2859-1(= ISO 2859-1 · MIL-STD-105E) 보통 검사 1회 샘플링의 표준값.
 *
 * 1. 표 1: LOT 크기 + 검사 수준 → 시료 문자
 * 2. 표 2-A: 시료 문자 + AQL → 시료 수 n · 합격 판정 수 Ac · 불합격 판정 수 Re
 *    표 2-A 는 대각선마다 값이 같다(시료 문자가 한 칸 내려가면 AQL 이 한 칸 낮아진 칸과 같은 값). 화살표 칸(↓ · ↑)은
 *    화살표 방향의 첫 계획을 쓴다 — 그때 시료 수도 그 계획의 것이다.
 * 3. 시료 수가 LOT 크기 이상이면 전수 검사다(표준 규칙).
 *
 * AQL 은 불량률(%) 범위인 0.010~10 만 받는다 — 그보다 큰 값(100 단위당 부적합 수)은 쓰지 않는다.
 */

/** 검사 방식 코드(`INSPECTION_SAMPLING_METHOD`) — 시료 수 · 판정 수를 이 표로 정한다. */
export const AQL_SAMPLING = 'AQL';

export const INSPECTION_LEVELS = ['G-I', 'G-II', 'G-III', 'S-1', 'S-2', 'S-3', 'S-4'] as const;
export type InspectionLevel = (typeof INSPECTION_LEVELS)[number];

export const AQL_VALUES = [
  0.01, 0.015, 0.025, 0.04, 0.065, 0.1, 0.15, 0.25, 0.4, 0.65, 1, 1.5, 2.5, 4, 6.5, 10,
] as const;

/** 시료 문자 A~R(I · O 는 쓰지 않는다)와 그 시료 수. */
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R'] as const;
const SAMPLE_SIZES = [2, 3, 5, 8, 13, 20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000] as const;

/** 표 1 — LOT 크기 상한별 시료 문자. 열 순서는 S-1 · S-2 · S-3 · S-4 · G-I · G-II · G-III. */
const LEVEL_COLUMNS: readonly InspectionLevel[] = ['S-1', 'S-2', 'S-3', 'S-4', 'G-I', 'G-II', 'G-III'];
const CODE_LETTER_TABLE: readonly (readonly [number, string])[] = [
  [8, 'AAAAAAB'],
  [15, 'AAAAABC'],
  [25, 'AABBBCD'],
  [50, 'ABBCCDE'],
  [90, 'BBCCCEF'],
  [150, 'BBCDDFG'],
  [280, 'BCDEEGH'],
  [500, 'BCDEFHJ'],
  [1200, 'CCEFGJK'],
  [3200, 'CDEGHKL'],
  [10000, 'CDFGJLM'],
  [35000, 'CDFHKMN'],
  [150000, 'DEGJLNP'],
  [500000, 'DEGJMPQ'],
  [Number.POSITIVE_INFINITY, 'DEHKNQR'],
];

/**
 * 표 2-A 의 대각선 값 — 대각선 번호 = 시료 문자 순번 + AQL 순번(0.010 이 0).
 * 14 미만은 ↓, 15 는 ↑, 16 은 ↓, 24 초과는 ↑ 다.
 */
const DIAGONAL: Readonly<Record<number, readonly [number, number] | 'DOWN' | 'UP'>> = {
  14: [0, 1],
  15: 'UP',
  16: 'DOWN',
  17: [1, 2],
  18: [2, 3],
  19: [3, 4],
  20: [5, 6],
  21: [7, 8],
  22: [10, 11],
  23: [14, 15],
  24: [21, 22],
};

const cellOf = (diagonal: number): readonly [number, number] | 'DOWN' | 'UP' =>
  diagonal < 14 ? 'DOWN' : diagonal > 24 ? 'UP' : DIAGONAL[diagonal];

export interface AqlPlan {
  /** 표 1 에서 고른 시료 문자 — 화살표로 옮겨 가도 처음 문자를 남긴다. */
  codeLetter: string;
  /** 실제로 검사할 수 — 시료 수가 LOT 이상이면 LOT 수량(전수). */
  sampleSize: number;
  acceptanceNumber: number;
  rejectionNumber: number;
}

export const isAqlValue = (value: number): boolean => AQL_VALUES.some((aql) => aql === value);
export const isInspectionLevel = (value: string): value is InspectionLevel =>
  (INSPECTION_LEVELS as readonly string[]).includes(value);

/** LOT 크기 · 검사 수준 · AQL 로 시료 계획을 낸다. 표에 없는 AQL · 수준이거나 LOT 이 1 미만이면 null. */
export function aqlPlan(lotSize: number, level: string, aql: number): AqlPlan | null {
  const column = LEVEL_COLUMNS.indexOf(level as InspectionLevel);
  const aqlIndex = AQL_VALUES.findIndex((value) => value === aql);
  if (column < 0 || aqlIndex < 0 || !(lotSize >= 1)) return null;

  const [, letters] =
    CODE_LETTER_TABLE.find(([upper]) => lotSize <= upper) ?? CODE_LETTER_TABLE[CODE_LETTER_TABLE.length - 1];
  const codeLetter = letters[column];
  let index = LETTERS.indexOf(codeLetter as (typeof LETTERS)[number]);
  for (;;) {
    const cell = cellOf(index + aqlIndex);
    if (cell === 'DOWN') index += 1;
    else if (cell === 'UP') index -= 1;
    else {
      return {
        codeLetter,
        sampleSize: Math.min(SAMPLE_SIZES[index], lotSize),
        acceptanceNumber: cell[0],
        rejectionNumber: cell[1],
      };
    }
  }
}
