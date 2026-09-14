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

  it('explode:false 배열 질의는 쉼표로 나눠 검증한다 — 단일값도 배열이다(PLAN-WO-01 D1)', () => {
    const csv = contextFor('GET /mdm/equipments', { query: { equipmentTypeCode: 'INJECTION_MOLDING,PRESS' } });
    expect(guard.canActivate(csv.context)).toBe(true);
    expect(csv.request.query).toEqual({ equipmentTypeCode: ['INJECTION_MOLDING', 'PRESS'] });

    const single = contextFor('GET /mdm/equipments', { query: { equipmentTypeCode: 'PRESS' } });
    expect(guard.canActivate(single.context)).toBe(true);
    expect(single.request.query).toEqual({ equipmentTypeCode: ['PRESS'] });

    const absent = contextFor('GET /mdm/equipments', { query: { plantId: '4' } });
    expect(guard.canActivate(absent.context)).toBe(true);
    expect('equipmentTypeCode' in (absent.request.query as object)).toBe(false);
  });

  it('CSV 는 중복·순서·빈 토큰을 보존하고, 반복 키 배열의 원소는 다시 나누지 않는다 — 요약 targetIds', () => {
    const key = 'GET /app/document-issues/summary';
    const ordered = contextFor(key, { query: { targetTypeCode: 'LOT', targetIds: '2,1,2' } });
    expect(guard.canActivate(ordered.context)).toBe(true);
    expect(ordered.request.query).toEqual({ targetTypeCode: 'LOT', targetIds: [2, 1, 2] });

    for (const targetIds of ['2,,1', ['2', '1,3']]) {
      const denied = contextFor(key, { query: { targetTypeCode: 'LOT', targetIds } });
      expect(() => guard.canActivate(denied.context)).toThrow(ContractException);
    }
  });

  it('본문은 되돌려 쓰지 않는다 — 강제 변환을 하지 않으므로 바뀔 것이 없다', () => {
    const body = { roleCode: 'ROLE_X', roleName: '역할' };
    const { context, request } = contextFor('POST /app/roles', { body });

    guard.canActivate(context);

    expect(request.body).toBe(body);
  });

  it('P-8 permits only the forward TSPL rendition format and keeps path validation', () => {
    const key = 'GET /app/document-issues/{documentIssueLogId}/rendition';
    const allowed = contextFor(key, { query: { format: 'tspl' }, params: { documentIssueLogId: '7' } });
    expect(guard.canActivate(allowed.context)).toBe(true);
    expect(allowed.request.query).toEqual({ format: 'tspl' });
    expect(allowed.request.params).toEqual({ documentIssueLogId: 7 });

    for (const query of [{ format: 'zpl' }, { format: 'TSPL' }]) {
      const denied = contextFor(key, { query, params: { documentIssueLogId: '7' } });
      expect(() => guard.canActivate(denied.context)).toThrow(ContractException);
    }
    const badPath = contextFor(key, { query: { format: 'tspl' }, params: { documentIssueLogId: 'oops' } });
    expect(() => guard.canActivate(badPath.context)).toThrow(ContractException);
  });

  it('accepts both POP calendar dates and MOBILE ISO instants for inspection windows', () => {
    for (const query of [
      { equipmentId: '5', inspectedFrom: '2026-09-12', inspectedTo: '2026-09-12' },
      { equipmentId: '5', inspectedFrom: '2026-09-12T00:00:00.000Z', inspectedTo: '2026-09-12T10:00:00.000Z' },
    ]) {
      const { context } = contextFor('GET /maintenance/inspections', { query });
      expect(guard.canActivate(context)).toBe(true);
    }
  });
});
