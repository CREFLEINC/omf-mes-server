import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { attachSession } from '../../auth/session-resolver.service';
import { notificationWriteContext } from './notification-write-context';

function requestOf(userId = 11, body: unknown = undefined): Request {
  const request = {
    method: 'POST',
    path: '/api/app/notifications/21:read',
    headers: { 'idempotency-key': 'ccaf2607-31ca-4cb7-952d-09a8d2125098' },
    body,
  } as unknown as Request;
  attachSession(request, {
    userId,
    loginId: 'test',
    userName: '시험',
    scopes: [],
    roles: [],
    permissions: [],
    mustChangePassword: false,
  });
  return request;
}

describe('notificationWriteContext', () => {
  it('실제 세션 사용자·멱등 키·성공 상태를 전달한다', () => {
    const context = notificationWriteContext(requestOf(), 204);
    expect(context).toMatchObject({
      appUserId: 11,
      key: 'ccaf2607-31ca-4cb7-952d-09a8d2125098',
      successStatus: 204,
    });
  });

  it('세션이 없으면 사용자 조건을 생략하지 않고 401이다', () => {
    expect(() => notificationWriteContext({} as Request, 204)).toThrow(UnauthorizedException);
  });

  it('동일 키·다른 세션 주체의 지문을 구분한다', () => {
    // 결정 — 통보 103: 전역 멱등 키에서 다른 주체의 응답을 노출하지 않는다.
    expect(notificationWriteContext(requestOf(11), 204).fingerprint).not.toBe(
      notificationWriteContext(requestOf(12), 204).fingerprint,
    );
  });

  it.each([
    ['method', 'PUT'],
    ['path', '/api/app/notifications/22:read'],
    ['body', { userId: 12 }],
    ['query', { eventCode: 'APPROVAL_ACTION_REQUIRED' }],
  ])('%s가 바뀌면 다른 요청이다', (field, value) => {
    const first = requestOf();
    const changed = requestOf();
    Object.defineProperty(changed, field, { value });
    expect(notificationWriteContext(first, 204).fingerprint).not.toBe(
      notificationWriteContext(changed, 204).fingerprint,
    );
  });

  it('If-Match와 사용자 입력 헤더는 지문·세션을 바꾸지 않는다', () => {
    const request = requestOf();
    const first = notificationWriteContext(request, 204);
    request.headers['if-match'] = '999';
    request.headers['x-user-id'] = '12';
    request.headers['x-worker-no'] = '100027';
    expect(notificationWriteContext(request, 204)).toEqual(first);
  });

  it('본문은 변조하지 않고 동일 JSON의 키 순서를 같은 요청으로 읽는다', () => {
    const body = Object.freeze({ nested: { a: 1, b: 2 }, userId: 12 });
    const request = requestOf(11, body);
    expect(notificationWriteContext(request, 200).fingerprint).toBe(
      notificationWriteContext(requestOf(11, { userId: 12, nested: { b: 2, a: 1 } }), 200)
        .fingerprint,
    );
    expect(request.body).toBe(body);
    expect(body).toEqual({ nested: { a: 1, b: 2 }, userId: 12 });
  });
});
