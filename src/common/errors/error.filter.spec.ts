import { ArgumentsHost, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ContractException } from './contract.exception';
import { ERROR_CODE, INTERNAL_ERROR_CODE } from './error-codes';
import { ErrorResponseFilter } from './error.filter';
import { ErrorResponse } from './error-response';

/** 계약 원본에서 ErrorResponse 스키마를 읽어 온다 — 손으로 옮겨 적으면 그 순간 드리프트한다. */
function contractErrorResponseValidator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../../../contracts/app-공통.json'), 'utf8'),
  ) as { components: { schemas: Record<string, unknown> } };

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'contract', components: contract.components });

  return ajv.compile({ $ref: 'contract#/components/schemas/ErrorResponse' });
}

describe('ErrorResponseFilter', () => {
  const filter = new ErrorResponseFilter();
  let json: jest.Mock;
  let status: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;

    // 5xx 는 스택을 로그로 남긴다 — 테스트 출력이 그것으로 덮이지 않게 막는다.
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  const body = (): ErrorResponse => json.mock.calls[0][0] as ErrorResponse;

  it('ContractException 의 errors 를 그대로 봉투에 싣는다', () => {
    const errors = [
      { scope: 'screen' as const, code: ERROR_CODE.NOT_YOUR_TURN, message: '앞 단계 결재를 기다리는 중입니다.' },
      { scope: 'field' as const, field: 'orderQty', code: ERROR_CODE.RANGE, message: '1 이상이어야 합니다.' },
    ];

    filter.catch(new ContractException(HttpStatus.CONFLICT, errors), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(body().errors).toEqual(errors);
  });

  it('field 항목의 field·uniqueScope 를 보존한다', () => {
    filter.catch(
      new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'field',
          field: 'itemCode',
          code: ERROR_CODE.UNIQUE_VIOLATION,
          uniqueScope: ['plantId', 'itemCode'],
          message: '이미 쓰는 품목코드입니다.',
        },
      ]),
      host,
    );

    expect(body().errors[0]).toEqual({
      scope: 'field',
      field: 'itemCode',
      code: ERROR_CODE.UNIQUE_VIOLATION,
      uniqueScope: ['plantId', 'itemCode'],
      message: '이미 쓰는 품목코드입니다.',
    });
  });

  it('uniqueScope 는 없으면 키 자체를 싣지 않는다', () => {
    filter.catch(new NotFoundException('없는 자원입니다.'), host);

    expect(Object.keys(body().errors[0])).toEqual(['scope', 'code', 'message']);
  });

  it('HttpException(404) 을 scope=screen 항목 하나로 바꾼다', () => {
    filter.catch(new NotFoundException('없는 자원입니다.'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(body().errors).toEqual([
      { scope: 'screen', code: 'NOT_FOUND', message: '없는 자원입니다.' },
    ]);
  });

  it('403 은 FORBIDDEN 코드로 나간다 — 계약에서 가장 잦은 오류 상태다', () => {
    filter.catch(new HttpException('권한이 없습니다.', HttpStatus.FORBIDDEN), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(body().errors[0].code).toBe('FORBIDDEN');
  });

  it('정의되지 않은 예외는 500 을 내고 내부 메시지를 싣지 않는다', () => {
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.7:5432'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body().errors).toEqual([
      { scope: 'screen', code: INTERNAL_ERROR_CODE, message: '요청을 처리하지 못했습니다.' },
    ]);
    expect(JSON.stringify(body())).not.toContain('ECONNREFUSED');
  });

  it('계약 스키마 검증기가 실제로 거른다 — 위 검사가 헛통과가 아님을 보인다', () => {
    const validate = contractErrorResponseValidator();

    expect(validate({ errors: [{ scope: 'banner', code: 'X', message: 'y' }] })).toBe(false);
    expect(validate({ errors: [{ scope: 'screen', code: 'X' }] })).toBe(false);
    expect(validate({})).toBe(false);
  });

  it('⭐ 응답 본문이 계약의 ErrorResponse 스키마를 만족한다', () => {
    const validate = contractErrorResponseValidator();

    const cases: unknown[] = [
      new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'field', field: 'dueDate', code: ERROR_CODE.REQUIRED, message: '필수입니다.' },
      ]),
      new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'field',
          field: 'itemCode',
          code: ERROR_CODE.UNIQUE_VIOLATION,
          uniqueScope: ['plantId', 'itemCode'],
          message: '중복입니다.',
        },
      ]),
      new NotFoundException('없는 자원입니다.'),
      new Error('내부 오류'),
    ];

    for (const exception of cases) {
      json.mockClear();
      filter.catch(exception, host);

      expect(validate(json.mock.calls[0][0])).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
    }
  });
});
