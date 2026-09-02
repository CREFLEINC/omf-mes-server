import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

import { ContractException } from './contract.exception';
import { INTERNAL_ERROR_CODE } from './error-codes';
import { ErrorItem, ErrorResponse } from './error-response';

/**
 * 나가는 모든 오류를 계약 `ErrorResponse` 봉투 하나로 맞춘다.
 *
 * 계약은 400·403·404·409·422 응답 전건이 이 봉투를 참조한다. 5xx 는 계약에 정의가
 * 없지만 **봉투를 바꾸지 않는다** — 클라이언트가 오류 처리 분기를 둘로 두지 않게 한다.
 */
@Catch()
export class ErrorResponseFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorResponseFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
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

    // 여기까지 온 것은 우리가 의도한 적 없는 오류다. 내부 메시지·스택은 응답에 싣지 않고
    // 로그로만 남긴다 — 스택에 접속 문자열·파일 경로가 섞여 나간 사고가 흔하다.
    this.logger.error('처리되지 않은 예외', exception instanceof Error ? exception.stack : exception);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errors: [{ scope: 'screen', code: INTERNAL_ERROR_CODE, message: '요청을 처리하지 못했습니다.' }],
    };
  }
}
