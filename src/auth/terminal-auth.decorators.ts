import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

import { TerminalPrincipal } from './terminal-auth.service';

/**
 * 현장 단말(POP·모바일) 전용 엔드포인트. **사람 토큰으로는 통과하지 못한다** —
 * 관리자 토큰으로 현장 실적을 올릴 수 있으면 작업자 귀속(worker_id)이 무의미해진다.
 * 근거: research/2026-07-28-POP-단말인증-설계검토.md §3.4
 */
export const TERMINAL_AUTH_KEY = 'auth:terminal';
export const TerminalAuth = () => SetMetadata(TERMINAL_AUTH_KEY, true);

export const CurrentTerminal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TerminalPrincipal => {
    return ctx.switchToHttp().getRequest<{ terminal: TerminalPrincipal }>().terminal;
  },
);

/**
 * 작업자 사번(`X-Worker-No`). **인증이 아니라 귀속 정보다** — 도용 리스크는
 * 확정 설계가 수용했다(WF02 S5 Boundary). 값이 없으면 undefined를 돌려주고,
 * 사번이 필수인 엔드포인트는 서비스에서 판단한다.
 */
export const WORKER_NO_HEADER = 'x-worker-no';

export const WorkerNo = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const header = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers[WORKER_NO_HEADER];
    return typeof header === 'string' && header.length > 0 ? header : undefined;
  },
);
