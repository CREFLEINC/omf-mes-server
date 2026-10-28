import type { Request } from 'express';

export interface TerminalContext {
  terminalId: bigint;
  terminalCode: string;
  plantId: bigint;
  terminalTypeCode: string;
  equipmentId: bigint | null;
  /** 단말의 창고(omf-all-around#190) — 있으면 적치·피킹·이동·출하 포장 목록과 작업 수를 그 창고로 거른다. */
  warehouseId?: bigint | null;
  /** Only JWT-verified contexts contain this; legacy test scope fixtures omit it. */
  tokenVersion?: number;
}

const ATTACHED_TERMINAL = Symbol('terminal');

export function currentTerminal(request: Request): TerminalContext | undefined {
  return (request as Request & { [ATTACHED_TERMINAL]?: TerminalContext })[ATTACHED_TERMINAL];
}

export function attachTerminal(request: Request, terminal: TerminalContext): void {
  (request as Request & { [ATTACHED_TERMINAL]?: TerminalContext })[ATTACHED_TERMINAL] = Object.freeze(terminal);
}
