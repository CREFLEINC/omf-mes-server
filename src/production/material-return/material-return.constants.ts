/**
 * 반납 상태. 계약 `MaterialReturn.statusCode` 가 `x-no-code-key` 라 공통코드가 아니라 서버 상수다(문의 053).
 * 옛 「반출 요청」 행은 `REQUESTED`, 반납 입고(피처 019)는 요청 단계 없이 바로 `RECEIVED` 다 — 전이 액션은 없다(FR-009).
 *
 * ⛔ 조회는 이 값을 대조하지 않는다 — 목록 질의는 받은 문자를 그대로 건다(I-10 §5-3).
 */
export const RETURN_REQUESTED = 'REQUESTED';
export const RETURN_RECEIVED = 'RECEIVED';

/** 귀속 방법(데이터 모델 §2) — 017 최종 마감 계산·감사용이고 화면에 보이지 않는다(FR-013). */
export const ATTRIBUTION = {
  /** LOT 스캔 — 그 LOT 의 가장 최근 W/O 출고 W/O. */
  AUTO_LATEST_ISSUE: 'AUTO_LATEST_ISSUE',
  /** W/O 로 찾기 — 고른 W/O(가장 최근 출고 W/O 와 같아야 한다). */
  WORK_ORDER_PICKED: 'WORK_ORDER_PICKED',
  /** 그 W/O 가 최종 마감(017) — 재고는 받고 귀속하지 않는다(FR-011). */
  NONE_FINALIZED: 'NONE_FINALIZED',
} as const;
export type AttributionCode = (typeof ATTRIBUTION)[keyof typeof ATTRIBUTION];

/** 원장의 거래 유형이자 원천 문서 유형(시드 원천 문서 목록 · 마이그 20261127190000). */
export const MATERIAL_RETURN_DOCUMENT = 'MATERIAL_RETURN';

/** 처리 단말 종류 — 계정 세션 호출이면 비운다. */
export const TERMINAL_KIND = { POP: 'POP', MOBILE: 'PDA' } as const;

/** 반납 거절 문구 — POP·PDA 가 서버 문구를 그대로 보인다(시안 확정 2026-11-27). */
export const RETURN_MESSAGES = {
  NOT_RETURNABLE: '반납할 수 있는 자재 LOT 이 아닙니다',
  NOTHING_TO_RETURN: '반납할 양이 남지 않았습니다',
  overReturnable: (returnable: string) => `출고된 양보다 많이 반납할 수 없습니다 (반납 가능 ${returnable})`,
  WORK_ORDER_MISMATCH: '고른 W/O 가 이 LOT 의 가장 최근 출고 W/O 가 아닙니다. 다시 찾아 고르세요',
} as const;
