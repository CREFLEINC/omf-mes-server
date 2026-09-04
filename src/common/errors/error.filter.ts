import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { ConflictException } from './conflict.exception';
import { ContractException } from './contract.exception';
import { INTERNAL_ERROR_CODE } from './error-codes';
import { ErrorItem, ErrorResponse } from './error-response';
import { prismaErrorResponse } from './prisma-error';

/**
 * 나가는 오류를 계약이 정한 봉투로 맞춘다.
 *
 * ⛔ **봉투가 둘이다.** 400·403·404·422 는 `ErrorResponse`(`{ errors: [...] }`)이고
 * **409 는 `ConflictResponse`(`{ conflictCause, message }`)** 다 — 실측으로 409 를
 * 선언한 175 오퍼레이션 중 173 이 그쪽이다. 처음에 「전건이 같은 봉투」로 읽고 409 도
 * `errors` 로 내렸는데, 그러면 화면이 `conflictCause` 를 못 찾아 「다른 사용자가 먼저
 * 저장했다」와 「기간계 배치가 덮었다」를 같은 문구로 안내한다.
 *
 * 5xx 는 계약에 정의가 없지만 `ErrorResponse` 를 쓴다 — 클라이언트가 알 수 없는 오류를
 * 다루는 분기를 하나로 둔다.
 */
@Catch()
export class ErrorResponseFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorResponseFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // ⛔ 409 는 봉투가 다르다 — 여기서 씌우면 계약과 어긋난다.
    if (exception instanceof ConflictException) {
      response.status(exception.getStatus()).json(exception.conflict);
      return;
    }

    const { status, errors } = this.toErrorResponse(exception);
    response.status(status).json({ errors } satisfies ErrorResponse);
  }

  private toErrorResponse(exception: unknown): { status: number; errors: ErrorItem[] } {
    if (exception instanceof ContractException) {
      return { status: exception.getStatus(), errors: exception.errors };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        // HttpStatus 는 역방향 매핑을 갖는 숫자 enum 이라 404 → 'NOT_FOUND' 가 된다.
        // 계약이 code 를 「등」으로 열어 두었으므로 상태 이름을 그대로 코드로 쓴다.
        errors: [{ scope: 'screen', code: HttpStatus[status] ?? 'ERROR', message: exception.message }],
      };
    }

    // ⛔ Prisma 오류를 여기서 «가로챈다». 이 분기가 없으면 없는 FK id 하나가 500 으로
    // 나가고, 화면은 고칠 수 있는 입력 오류를 서버 장애로 보인다.
    const prisma = prismaErrorResponse(exception);
    if (prisma) return prisma;

    // 여기까지 온 것은 우리가 의도한 적 없는 오류다. 내부 메시지·스택은 응답에 싣지 않고
    // 로그로만 남긴다 — 스택에 접속 문자열·파일 경로가 섞여 나간 사고가 흔하다.
    this.logger.error('처리되지 않은 예외', exception instanceof Error ? exception.stack : exception);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errors: [{ scope: 'screen', code: INTERNAL_ERROR_CODE, message: '요청을 처리하지 못했습니다.' }],
    };
  }
}
