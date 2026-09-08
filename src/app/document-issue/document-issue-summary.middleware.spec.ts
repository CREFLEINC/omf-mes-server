import type { NextFunction, Request, Response } from 'express';

import { DocumentIssueSummaryMiddleware } from './document-issue-summary.middleware';

describe('발행 요약 CSV 미들웨어 (I-27 P2)', () => {
  const middleware = new DocumentIssueSummaryMiddleware();

  it('scalar targetIds만 쉼표 그대로 나누고 빈 token·중복·순서를 보존한다', () => {
    const request = { query: { targetIds: '2,,1,2' } } as unknown as Request;
    const next = jest.fn() as NextFunction;
    middleware.use(request, {} as Response, next);
    expect(request.query).toEqual({ targetIds: ['2', '', '1', '2'] });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('repeated-key 배열은 원소 안 CSV까지 추가 분해하지 않는다', () => {
    const targetIds = ['2', '1,3'];
    const request = { query: { targetIds } } as unknown as Request;
    middleware.use(request, {} as Response, jest.fn());
    expect(request.query.targetIds).toBe(targetIds);
  });

  it('targetIds가 없으면 없는 상태로 query 사본만 고정한다', () => {
    const original = { documentTypeCode: 'TOOL_LABEL' };
    const request = { query: original } as unknown as Request;
    middleware.use(request, {} as Response, jest.fn());
    expect(request.query).toEqual(original);
    expect(request.query).not.toBe(original);
    expect('targetIds' in request.query).toBe(false);
  });
});
