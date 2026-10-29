import type { Request } from 'express';

import { TERMINAL_WORK_OPERATIONS, assertTerminalWorkScope } from './terminal-work-scope';

function request(query: Record<string, unknown> = {}): Request {
  return { query, params: {}, headers: {} } as unknown as Request;
}

describe('단말 작업 수 범위', () => {
  it('US3-1 US3-6 POP·모바일 단말 둘 다 연다', () => {
    expect(TERMINAL_WORK_OPERATIONS['GET /app/terminal-work-counts']).toEqual(['POP', 'MOBILE']);
  });

  it('질의 없이 부르면 통과한다', () => {
    expect(() => assertTerminalWorkScope(request(), 'GET /app/terminal-work-counts')).not.toThrow();
  });

  it('공장·창고 따위 질의를 실으면 401 이다 — 범위는 토큰이 정한다', () => {
    expect(() => assertTerminalWorkScope(request({ plantId: '9' }), 'GET /app/terminal-work-counts')).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('등록하지 않은 오퍼레이션은 401 이다', () => {
    expect(() => assertTerminalWorkScope(request(), 'GET /app/notifications')).toThrow(expect.objectContaining({ status: 401 }));
  });
});
