import { HttpStatus, INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { ContractException } from '../errors';

/**
 * 본문 해석기를 Nest 기본값 그대로 «먼저» 달고, 바로 뒤에 해석 오류를 계약 봉투로 바꾸는 층을 단다.
 *
 * ⛔ Nest 기본 해석기에 맡기면 오류가 두 갈래로 샌다 — 깨진 JSON 은 Nest 가 `BadRequestException(원문)` 으로
 * 바꿔 「Unexpected token …」(보낸 본문 일부가 섞인다)이 그대로 나가고, 크기 초과·charset·압축 오류는
 * HttpException 이 아니라 500 이 된다. Nest 가 오류의 `type` 을 버린 뒤라 응답 필터에서는 가를 수 없다.
 * 여기서 먼저 단 해석기는 이름(jsonParser·urlencodedParser)이 같아 Nest 가 `init` 때 다시 달지 않는다.
 */
export function configureBodyParsing(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.useBodyParser('json');
  express.useBodyParser('urlencoded', { extended: true });
  express.use(bodyParseError);
}

/** body-parser 가 오류에 붙이는 표시. http-errors 꼴이다. */
interface BodyParserError {
  type?: unknown;
  status?: unknown;
  limit?: unknown;
}

function bodyParseError(error: unknown, _request: Request, _response: Response, next: NextFunction): void {
  const { type, status, limit } = (error ?? {}) as BodyParserError;
  // 해석기 오류가 아니거나 서버 쪽 사정(5xx)이면 손대지 않는다 — 응답 필터가 500 으로 다룬다.
  if (typeof type !== 'string' || typeof status !== 'number' || status >= 500) {
    next(error);
    return;
  }
  // 원문(`error.message`)은 싣지 않는다 — 보낸 본문 일부가 섞인다.
  next(new ContractException(status, [{ scope: 'screen', code: HttpStatus[status] ?? 'ERROR', message: messageFor(type, limit) }]));
}

function messageFor(type: string, limit: unknown): string {
  switch (type) {
    case 'entity.parse.failed':
      return '요청 본문이 JSON 객체 형식이 아닙니다. 올바른 JSON 객체로 보내세요.';
    case 'entity.too.large': {
      const size = typeof limit === 'number' ? `(최대 ${Math.floor(limit / 1024)}kb)` : '';
      return `요청 본문이 너무 큽니다${size}. 본문을 줄이거나 나눠 보내세요.`;
    }
    case 'charset.unsupported':
      return '요청 본문의 문자 인코딩(charset)을 지원하지 않습니다. UTF-8 로 보내세요.';
    case 'encoding.unsupported':
      return '요청 본문의 압축 방식(Content-Encoding)을 지원하지 않습니다. 압축하지 않거나 gzip·deflate·br 중 하나로 보내세요.';
    default:
      return '요청 본문을 읽지 못했습니다. 본문과 Content-Type·Content-Length 헤더를 확인해 다시 보내세요.';
  }
}
