import type { Request, Response } from 'express';

import { CredentialService } from '../../auth/credential.service';
import { SessionResolver, attachSession } from '../../auth/session-resolver.service';
import { Session } from '../../auth/session.types';
import { IdempotencyService } from '../../common/idempotency';
import { AppUserController } from './app-user.controller';
import { AppUserService } from './app-user.service';
import { UserAssignmentService } from './user-assignment.service';

const RESET = { appUserId: 1002, temporaryPassword: 'SynTmp9x2kAb', resetAt: '2026-09-18T03:00:00.000Z' };

const setup = (actorId: number) => {
  const idempotency = {
    run: jest.fn(async (_options: unknown, work: (tx: unknown) => Promise<unknown>) => ({
      body: await work({}),
    })),
  } as unknown as IdempotencyService;
  const assignments = {
    resetPassword: jest.fn().mockResolvedValue(RESET),
  } as unknown as UserAssignmentService;
  const credentials = { changePassword: jest.fn().mockResolvedValue(undefined) } as unknown as CredentialService;
  const reissue = jest.fn().mockResolvedValue(undefined);
  const resolver = { reissue } as unknown as SessionResolver;
  const controller = new AppUserController(
    {} as AppUserService,
    assignments,
    credentials,
    resolver,
    idempotency,
  );
  const request = { method: 'POST', path: '/app/users', headers: {}, body: undefined } as unknown as Request;
  attachSession(request, { userId: actorId } as Session);
  return { controller, request, response: {} as Response, reissue };
};

describe('비밀번호 초기화·변경 뒤 요청한 세션 살리기', () => {
  it('남의 계정을 초기화하면 관리자 자신의 쿠키는 그대로 둔다', async () => {
    const { controller, request, response, reissue } = setup(1001);

    await expect(controller.resetPassword(request, response, 1002)).resolves.toEqual(RESET);
    expect(reissue).not.toHaveBeenCalled();
  });

  it('자기 계정을 초기화하면 이 세션만 새 쿠키로 살린다 — 임시 비밀번호를 읽을 창이 끊기면 안 된다', async () => {
    const { controller, request, response, reissue } = setup(1002);

    await expect(controller.resetPassword(request, response, 1002)).resolves.toEqual(RESET);
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(reissue).toHaveBeenCalledWith(request, response);
  });

  it('본인이 비밀번호를 바꾸면 이 세션은 새 쿠키로 살린다 — 바꾼 뒤 다시 로그인시키지 않는다', async () => {
    const { controller, request, response, reissue } = setup(1001);

    await controller.changePassword(request, response, {
      currentPassword: 'OldPw1234',
      newPassword: 'NewPw5678',
    });
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(reissue).toHaveBeenCalledWith(request, response);
  });
});
