import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyStore, Lookup } from './idempotency.store';

const KEY = '11111111-2222-4333-8444-555555555555';

function context(
  method = 'POST',
  headers: Record<string, string> = { 'idempotency-key': KEY },
): ExecutionContext {
  const request = { method, path: '/api/mdm/warehouses', body: { a: 1 }, headers };
  const sent: Record<string, string> = {};
  const response = {
    statusCode: 201,
    status: jest.fn(),
    setHeader: jest.fn((name: string, value: string) => {
      sent[name] = value;
    }),
    getHeader: jest.fn((name: string) => (name === 'etag' ? '4' : undefined)),
    sentHeaders: sent,
  };

  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function build(lookup: Lookup = { kind: 'fresh' }, skip = false) {
  const store = {
    claim: jest.fn().mockResolvedValue(lookup),
    complete: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    sweepExpired: jest.fn().mockResolvedValue(0),
  } as unknown as IdempotencyStore;

  const reflector = { getAllAndOverride: () => skip } as unknown as Reflector;

  return { interceptor: new IdempotencyInterceptor(store, reflector), store };
}

const handler = (result = 'ok'): CallHandler => ({ handle: () => of(result) });
const failing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });

describe('IdempotencyInterceptor', () => {
  it('조회는 그냥 통과한다 — 멱등 대상이 아니다', async () => {
    const { interceptor, store } = build();

    await firstValueFrom(await interceptor.intercept(context('GET'), handler()));

    expect(store.claim).not.toHaveBeenCalled();
  });

  it('@SkipIdempotency() 가 붙으면 통과한다 — 계약 밖 엔드포인트', async () => {
    const { interceptor, store } = build({ kind: 'fresh' }, true);

    await firstValueFrom(await interceptor.intercept(context(), handler()));

    expect(store.claim).not.toHaveBeenCalled();
  });

  it.each([
    ['헤더가 없으면', {}],
    ['uuid 가 아니면', { 'idempotency-key': 'nope' }],
  ])('%s 400 이다', async (_label, headers) => {
    const { interceptor } = build();

    expect(() => interceptor.intercept(context('POST', headers), handler())).toThrow(
      BadRequestException,
    );
  });

  describe('성공 응답', () => {
    it('기록을 COMPLETED 로 바꾼 뒤에 응답을 내보낸다', async () => {
      // 흘려보내면 응답이 먼저 나가고, 빠른 재전송이 IN_PROGRESS 를 보고 409 를 받는다.
      const { interceptor, store } = build();

      const result = await firstValueFrom(interceptor.intercept(context(), handler('created')));

      expect(store.complete).toHaveBeenCalledWith(KEY, {
        status: 201,
        body: 'created',
        headers: { etag: '4' },
      });
      expect(result).toBe('created');
    });
  });

  describe('오류 응답', () => {
    it('4xx 는 저장한다 — 다시 보내도 결과가 같다', async () => {
      const { interceptor, store } = build();
      const error = new BadRequestException({ errors: [] });

      await expect(
        firstValueFrom(interceptor.intercept(context(), failing(error))),
      ).rejects.toBe(error);

      expect(store.complete).toHaveBeenCalledWith(KEY, { status: 400, body: error.getResponse() });
      expect(store.release).not.toHaveBeenCalled();
    });

    it('5xx 는 기록을 지운다 — 일시적일 수 있어 다시 시도할 수 있어야 한다', async () => {
      const { interceptor, store } = build();

      await expect(
        firstValueFrom(interceptor.intercept(context(), failing(new InternalServerErrorException()))),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(store.release).toHaveBeenCalledWith(KEY);
      expect(store.complete).not.toHaveBeenCalled();
    });

    it('HttpException 이 아닌 오류도 5xx 로 보고 기록을 지운다', async () => {
      const { interceptor, store } = build();

      await expect(
        firstValueFrom(interceptor.intercept(context(), failing(new Error('boom')))),
      ).rejects.toThrow('boom');

      expect(store.release).toHaveBeenCalledWith(KEY);
    });
  });

  it('저장된 응답이 있으면 핸들러를 돌리지 않는다', async () => {
    const { interceptor } = build({
      kind: 'replay',
      response: { status: 201, body: { warehouseId: 7 } },
    });
    const spy = jest.fn(() => of('새로 실행됨'));

    const result = await firstValueFrom(interceptor.intercept(context(), { handle: spy }));

    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ warehouseId: 7 });
  });

  it('재생 시 저장된 헤더도 되돌려준다 — ETag 가 없으면 다음 쓰기를 못 한다', async () => {
    const { interceptor } = build({
      kind: 'replay',
      response: { status: 200, body: {}, headers: { etag: '9' } },
    });
    const ctx = context();

    await firstValueFrom(interceptor.intercept(ctx, handler()));

    const response = ctx.switchToHttp().getResponse<{ sentHeaders: Record<string, string> }>();
    expect(response.sentHeaders).toEqual({ etag: '9' });
  });
});
