import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

/**
 * Prisma 오류를 HTTP 응답으로 변환한다.
 * 서비스 계층에서 선제 검증하지 못한 경합(동시 등록 등)이 여기로 떨어진다.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    const { status, message } = this.translate(exception);
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      error: exception.code,
    });
  }

  private translate(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
  } {
    switch (exception.code) {
      case 'P2002':
        return { status: HttpStatus.CONFLICT, message: '이미 존재하는 코드입니다.' };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          message: '참조 중인 데이터가 있어 처리할 수 없습니다.',
        };
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, message: '대상을 찾을 수 없습니다.' };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: '데이터 처리 중 오류가 발생했습니다.',
        };
    }
  }
}
