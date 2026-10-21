/**
 * 품목별 IQC 검사 수준(omf-all-around#64 · 장부 P-85). 샘플 수량·판정 기준은 바꾸지 않는다 — 표시·기록만.
 * ⭐ 셈 규칙은 `nextInspectionLevel` «한 곳»이다 — 담당자 결정(2026-10-21)이 바뀌면 여기만 고친다.
 */
export const INSPECTION_LEVELS = ['NONE', 'REDUCED', 'NORMAL', 'TIGHTENED'] as const;
export type InspectionLevelCode = (typeof INSPECTION_LEVELS)[number];

export const NONE: InspectionLevelCode = 'NONE';
const REDUCED: InspectionLevelCode = 'REDUCED';
const NORMAL: InspectionLevelCode = 'NORMAL';
const TIGHTENED: InspectionLevelCode = 'TIGHTENED';

/** 보통에서 연속 합격 이만큼이면 수월. */
export const ACCEPTS_TO_REDUCED = 15;
/** 엄격에서 연속 합격 이만큼이면 보통. */
export const ACCEPTS_TO_NORMAL = 5;

const ACCEPTED = 'ACCEPTED';
const REJECTED = 'REJECTED';

export interface LevelState {
  level: InspectionLevelCode;
  consecutiveAcceptCount: number;
}

export interface LevelStep extends LevelState {
  switched: boolean;
  /** 합격 연속으로 전환됐으면 그 연속 수 — 이력의 사유가 된다. */
  acceptStreak?: number;
}

export function isInspectionLevel(value: unknown): value is InspectionLevelCode {
  return typeof value === 'string' && (INSPECTION_LEVELS as readonly string[]).includes(value);
}

/**
 * IQC 최종 판정 하나를 센다. 합격만 연속 수를 올리고, 불합격은 엄격으로 보내며 연속 수를 0 으로 돌린다.
 * 그 밖의 판정(보류)은 아무것도 바꾸지 않는다. 전환되면 연속 수는 0 부터 다시 센다.
 * ⛔ 무검사는 자동 전환 대상이 아니다 — 수동으로만 들어오고 나간다.
 */
export function nextInspectionLevel(state: LevelState, judgment: string): LevelStep {
  const unchanged: LevelStep = { ...state, switched: false };
  if (state.level === NONE) return unchanged;
  if (judgment === REJECTED) {
    return { level: TIGHTENED, consecutiveAcceptCount: 0, switched: state.level !== TIGHTENED };
  }
  if (judgment !== ACCEPTED) return unchanged;
  const streak = state.consecutiveAcceptCount + 1;
  if (state.level === NORMAL && streak >= ACCEPTS_TO_REDUCED) {
    return { level: REDUCED, consecutiveAcceptCount: 0, switched: true, acceptStreak: streak };
  }
  if (state.level === TIGHTENED && streak >= ACCEPTS_TO_NORMAL) {
    return { level: NORMAL, consecutiveAcceptCount: 0, switched: true, acceptStreak: streak };
  }
  return { level: state.level, consecutiveAcceptCount: streak, switched: false };
}
