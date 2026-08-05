import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable, catchError, from, of, switchMap, throwError } from 'rxjs';

import { AuthPrincipal } from '../../auth/auth.decorators';
import { ContractBadRequest, ErrorCode, fieldError, screenError } from '../errors/contract-error';
import { requestFingerprint } from './fingerprint';
import { SKIP_IDEMPOTENCY_KEY } from './idempotency.decorators';
import { IdempotencyStore, StoredResponse } from './idempotency.store';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER = 'idempotency-key';

/**
 * 응답이 유실된 뒤의 재전송을 처음 응답으로 되돌려준다.
 *
 * **`If-Match` 검사보다 앞에 있어야 한다.** 인터셉터 → 핸들러 → 서비스 순서라 자기
 * 재전송은 저장된 응답을 받고 버전 검사에 닿지 않는다. 그러지 않으면 1차에서
 * `version_no` 가 올랐는데 클라이언트는 새 ETag 를 못 받아 옛 `If-Match` 로
 * 재전송하고, 계약의 `conflictCause='user'` 때문에 「다른 사용자가 먼저 수정했습니다」
 * 라고 안내된다 — 다른 사용자는 없었다.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly store: IdempotencyStore,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthPrincipal }>();

    if (!WRITE_METHODS.has(request.method)) return next.handle();

    // 계약(mdm-기준정보.json) 밖의 쓰기 — 로그인 등. 기본이 「요구함」이라 새 쓰기를
    // 만들며 깜빡해도 보호되고, 빼는 쪽만 명시한다.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_IDEMPOTENCY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const key = this.readKey(request);
    const fingerprint = requestFingerprint(request.method, request.path, request.body);

    return from(this.store.claim(key, fingerprint, request.user?.appUserId)).pipe(
      switchMap((lookup) => {
        if (lookup.kind === 'mismatch') {
          throw new ContractBadRequest([
            fieldError(
              'Idempotency-Key',
              ErrorCode.RANGE,
              '같은 멱등 키로 다른 요청을 보냈습니다.',
            ),
          ]);
        }

        if (lookup.kind === 'inProgress') {
          throw new ConflictException({
            errors: [screenError('IN_PROGRESS', '같은 요청을 처리 중입니다.')],
          });
        }

        if (lookup.kind === 'replay') return of(this.replay(http.getResponse<Response>(), lookup.response));

        return this.run(next, http.getResponse<Response>(), key);
      }),
    );
  }

  /** 저장된 응답을 그대로 되돌려준다. 핸들러는 돌지 않는다. */
  private replay(response: Response, stored: StoredResponse): unknown {
    response.status(stored.status);

    return stored.body;
  }

  private run(next: CallHandler, response: Response, key: string): Observable<unknown> {
    return next.handle().pipe(
      // 기록 갱신을 기다린 뒤에 응답을 내보낸다. 흘려보내면 응답이 먼저 나가고,
      // 아주 빠른 재전송이 아직 IN_PROGRESS 인 기록을 보고 409 를 받는다.
      switchMap(async (body) => {
        await this.store.complete(key, { status: response.statusCode, body });
        void this.sweep();

        return body;
      }),
      catchError((error: unknown) =>
        from(this.finishFailed(key, error)).pipe(switchMap(() => throwError(() => error))),
      ),
    );
  }

  /**
   * 4xx 는 저장한다 — 입력이 틀린 것이라 다시 보내도 결과가 같고, 저장해 두면 검증을
   * 다시 돌리지 않는다. 5xx 는 기록을 지운다 — 일시적일 수 있는 오류를 저장하면
   * 그 키가 보관 기간 내내 같은 500 을 낸다.
   */
  private async finishFailed(key: string, error: unknown): Promise<void> {
    const status =
      error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      await this.store.release(key);

      return;
    }

    await this.store.complete(key, {
      status,
      body: error instanceof HttpException ? error.getResponse() : null,
    });
    void this.sweep();
  }

  /** 정리 실패가 요청을 깨뜨리지 않게 한다 — 부수 작업이다. */
  private async sweep(): Promise<void> {
    try {
      await this.store.sweepExpired();
    } catch (error) {
      this.logger.warn(`멱등 기록 정리 실패: ${String(error)}`);
    }
  }

  private readKey(request: Request): string {
    const value = request.headers[HEADER];
    const key = Array.isArray(value) ? value[0] : value;

    if (!key || !UUID.test(key)) {
      throw new ContractBadRequest([
        fieldError('Idempotency-Key', ErrorCode.REQUIRED, '멱등 키(UUID)가 필요합니다.'),
      ]);
    }

    return key.toLowerCase();
  }
}
