import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ContractException, ERROR_CODE } from '../errors';
import { CONTRACT_OPERATION } from './contract.decorator';
import { ContractRegistry } from './contract-registry';
import { ContractValidationGuard } from './contract-validation.guard';
import { ContractValidator } from './contract-validator';

describe('ContractValidationGuard', () => {
  const guard = new ContractValidationGuard(
    new Reflector(),
    new ContractValidator(ContractRegistry.load()),
  );

  function contextFor(
    key: string | undefined,
    request: { body?: unknown; query?: unknown; params?: unknown },
  ): { context: ExecutionContext; request: Record<string, unknown> } {
    const handler = (): void => undefined;
    if (key) Reflect.defineMetadata(CONTRACT_OPERATION, key, handler);

    const held = { body: {}, query: {}, params: {}, ...request } as Record<string, unknown>;
    const context = {
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => held }),
    } as unknown as ExecutionContext;

    return { context, request: held };
  }

  it('@Contract 가 없으면 검사하지 않고 지나간다', () => {
    const { context } = contextFor(undefined, { body: { 아무거나: 1 } });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('계약을 만족하면 통과시킨다', () => {
    const { context } = contextFor('POST /app/roles', {
      body: { roleCode: 'ROLE_X', roleName: '역할' },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('어긋나면 400 ContractException 을 던진다', () => {
    const { context } = contextFor('POST /app/roles', { body: { roleCode: 'ROLE_X' } });

    try {
      guard.canActivate(context);
      throw new Error('던졌어야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractException);
      const contractError = error as ContractException;
      expect(contractError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(contractError.errors).toMatchObject([
        { scope: 'field', field: 'roleName', code: ERROR_CODE.REQUIRED },
      ]);
    }
  });

  it('통과한 질의를 계약이 선언한 타입으로 되돌려 쓴다', () => {
    const { context, request } = contextFor('GET /app/approval-routes', {
      query: { businessUnitId: '10', activeOnly: 'true' },
    });

    guard.canActivate(context);

    expect(request.query).toEqual({ businessUnitId: 10, activeOnly: true });
  });

  it('본문은 되돌려 쓰지 않는다 — 강제 변환을 하지 않으므로 바뀔 것이 없다', () => {
    const body = { roleCode: 'ROLE_X', roleName: '역할' };
    const { context, request } = contextFor('POST /app/roles', { body });

    guard.canActivate(context);

    expect(request.body).toBe(body);
  });
});
