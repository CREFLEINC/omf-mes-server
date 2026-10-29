import type { Request } from 'express';

import { currentTerminal } from '../auth/terminal-context';

/**
 * 단말이 부른 물류 목록의 범위 — 공장, 그리고 단말에 창고가 있으면 그 창고(omf-all-around#190 · research R-5).
 * 창고 없는 단말은 지금처럼 공장 전체다. 단말 작업 수(`GET /app/terminal-work-counts`)도 같은 범위로 센다.
 */
export interface TerminalListScope {
  plantId: bigint;
  warehouseId: bigint | null;
}

export function terminalListScope(request: Request): TerminalListScope | undefined {
  const terminal = currentTerminal(request);
  return terminal === undefined ? undefined : { plantId: terminal.plantId, warehouseId: terminal.warehouseId ?? null };
}
