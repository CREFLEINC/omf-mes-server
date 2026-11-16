/**
 * 추적 시스템(flowtrack) 연동이 MES 에 보내는 전송(flowtrack 연동 제안 §3-3~3-5). 연동 단말 토큰만 받는다.
 * 공장 범위는 서비스가 건다 — 단말 공장의 W/O 만 찾는다.
 */
export const TERMINAL_TRACKING_SYSTEM_OPERATIONS: Readonly<Record<string, readonly 'TRACKING_SYSTEM'[]>> = {
  'POST /integration/tracking-system/stock-moves': ['TRACKING_SYSTEM'],
};
