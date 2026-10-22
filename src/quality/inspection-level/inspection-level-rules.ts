/**
 * 품목별 IQC 검사 수준(omf-all-around#64 · 장부 P-87). 샘플 수량·판정 기준은 바꾸지 않는다 — 표시·기록만.
 * 자동 전환(연속 합격 셈)은 없앴다 — 사용자가 정한 수준만 쓴다(omf-all-around#133).
 */
export const INSPECTION_LEVELS = ['NONE', 'REDUCED', 'NORMAL', 'TIGHTENED'] as const;
export type InspectionLevelCode = (typeof INSPECTION_LEVELS)[number];

export function isInspectionLevel(value: unknown): value is InspectionLevelCode {
  return typeof value === 'string' && (INSPECTION_LEVELS as readonly string[]).includes(value);
}
