import type { Request } from 'express';

export interface TerminalContext {
  terminalId: bigint;
  terminalCode: string;
  plantId: bigint;
  terminalTypeCode: string;
  equipmentId: bigint | null;
}

const ATTACHED_TERMINAL = Symbol('terminal');

export function currentTerminal(request: Request): TerminalContext | undefined {
  return (request as Request & { [ATTACHED_TERMINAL]?: TerminalContext })[ATTACHED_TERMINAL];
}

export function attachTerminal(request: Request, terminal: TerminalContext): void {
  (request as Request & { [ATTACHED_TERMINAL]?: TerminalContext })[ATTACHED_TERMINAL] = Object.freeze(terminal);
}
