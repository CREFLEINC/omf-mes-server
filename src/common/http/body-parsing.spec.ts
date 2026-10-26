import type { Request, Response } from 'express';

import { ContractException } from '../errors';
import { bodyParseError } from './body-parsing';

/** body-parser 가 내는 오류 꼴(http-errors) — 원문 message 에 보낸 본문이 섞이는 것까지 흉내 낸다. */
const parserError = (status: number, type: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('Unexpected token \'n\', "null" is not valid JSON'), { status, statusCode: status, type, ...extra });

function run(error: unknown): unknown {
  const next = jest.fn();
  bodyParseError(error, {} as Request, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0];
}

describe('본문 해석 오류 → 계약 봉투', () => {
  it.each([
    [400, 'entity.parse.failed', 'BAD_REQUEST', '요청 본문이 JSON 객체 형식이 아닙니다. 올바른 JSON 객체로 보내세요.', {}],
    [413, 'entity.too.large', 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다(최대 100kb). 본문을 줄이거나 나눠 보내세요.', { limit: 102400 }],
    [413, 'parameters.too.many', 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다. 본문을 줄이거나 나눠 보내세요.', {}],
    [415, 'charset.unsupported', 'UNSUPPORTED_MEDIA_TYPE', '요청 본문의 문자 인코딩(charset)을 지원하지 않습니다. UTF-8 로 보내세요.', {}],
    [
      415, 'encoding.unsupported', 'UNSUPPORTED_MEDIA_TYPE',
      '요청 본문의 압축 방식(Content-Encoding)을 지원하지 않습니다. 압축하지 않거나 gzip·deflate·br 중 하나로 보내세요.', {},
    ],
    [
      400, 'querystring.parse.rangeError', 'BAD_REQUEST',
      '요청 본문을 읽지 못했습니다. 본문과 Content-Type·Content-Length 헤더를 확인해 다시 보내세요.', {},
    ],
  ])('%i %s → %s · 문구, 원문은 싣지 않는다', (status, type, code, message, extra) => {
    const passed = run(parserError(status, type, extra));

    expect(passed).toBeInstanceOf(ContractException);
    expect((passed as ContractException).getStatus()).toBe(status);
    expect((passed as ContractException).errors).toEqual([{ scope: 'screen', code, message }]);
  });

  it('해석기 오류가 아니거나 5xx 면 손대지 않고 넘긴다 — 응답 필터가 다룬다', () => {
    const plain = new Error('boom');
    const serverSide = parserError(500, 'stream.not.readable');

    expect(run(plain)).toBe(plain);
    expect(run(serverSide)).toBe(serverSide);
    expect(run(undefined)).toBeUndefined();
  });
});
