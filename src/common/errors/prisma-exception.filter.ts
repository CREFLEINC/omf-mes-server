import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

import { ErrorCode, ErrorItem, ErrorResponse, screenError } from './contract-error';

/**
 * 서비스가 선제 검증으로 잡지 못한 DB 제약 위반을 계약 봉투로 바꾼다.
 *
 * 선제 조회만 믿으면 동시 요청 둘이 함께 통과한다 — 진 쪽이 여기로 떨어진다.
 * 화면은 선제 검증에 걸린 것과 경합에 진 것을 구분할 이유가 없으므로 같은 응답을 준다.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  /**
   * 유니크 위반의 **컬럼 목록** → 그 위반이 어떤 오류인지. 제약마다 어느 필드가
   * 문제인지가 달라 일괄 변환할 수 없다.
   *
   * 키가 제약 이름이 아닌 이유: Prisma 는 P2002 의 `meta.target` 에 제약 이름을 담지
   * 않는다. `uq_warehouse` 를 위반해도 `["plant_id","warehouse_code"]` 가 온다.
   */
  constructor(private readonly byTarget: Map<string, () => ErrorItem>) {}

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.translate(exception);

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
    }

    response.status(status).json(body);
  }

  private translate(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    body: ErrorResponse;
  } {
    if (exception.code === 'P2002') {
      const build = this.byTarget.get(targetKey(exception));
      if (build) return { status: HttpStatus.BAD_REQUEST, body: { errors: [build()] } };
    }

    if (exception.code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        body: { errors: [screenError(ErrorCode.RANGE, '대상을 찾을 수 없습니다.')] },
      };
    }

    // 알려진 매핑이 없으면 500 이다. 4xx 로 뭉뚱그리면 서버 결함이 사용자 입력 탓으로 보인다.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { errors: [screenError('INTERNAL_ERROR', '데이터 처리 중 오류가 발생했습니다.')] },
    };
  }
}

/** `meta.target` 은 위반한 유니크의 컬럼 목록이다. 배열로 오지만 문자열인 경우도 있다. */
function targetKey(exception: Prisma.PrismaClientKnownRequestError): string {
  const target = exception.meta?.target;

  return Array.isArray(target) ? target.join(',') : String(target ?? '');
}
