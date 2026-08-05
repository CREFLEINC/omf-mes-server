import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ErrorItem, ErrorResponse, fieldError } from './contract-error';
import { PrismaExceptionFilter } from './prisma-exception.filter';

const DUPLICATE: () => ErrorItem = () =>
  fieldError('warehouseCode', 'UNIQUE_VIOLATION', '중복입니다.', ['plantId', 'warehouseCode']);

function capture() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as ArgumentsHost;

  return { host, status, json };
}

function prismaError(code: string, target?: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: '6.19.3',
    meta: target === undefined ? undefined : { target },
  });
}

describe('PrismaExceptionFilter', () => {
  // 키는 제약 이름이 아니라 Prisma 가 실제로 담는 컬럼 목록이다. 실측으로 확인했다:
  //   uq_warehouse 위반 → meta = {"target":["plant_id","warehouse_code"]}
  const filter = new PrismaExceptionFilter(new Map([['plant_id,warehouse_code', DUPLICATE]]));

  it('아는 유니크 제약은 계약 봉투 400 으로 바꾼다', () => {
    const { host, status, json } = capture();

    filter.catch(prismaError('P2002', ['plant_id', 'warehouse_code']), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect((json.mock.calls[0][0] as ErrorResponse).errors).toEqual([DUPLICATE()]);
  });

  it('target 이 문자열로 와도 같게 다룬다', () => {
    const { host, json } = capture();

    filter.catch(prismaError('P2002', 'plant_id,warehouse_code'), host);

    expect((json.mock.calls[0][0] as ErrorResponse).errors[0]).toEqual(DUPLICATE());
  });

  it('모르는 유니크 제약은 500 이다 — 4xx 로 뭉뚱그리면 서버 결함이 입력 탓으로 보인다', () => {
    const { host, status } = capture();

    filter.catch(prismaError('P2002', ['other_column']), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('P2025 는 404 다', () => {
    const { host, status } = capture();

    filter.catch(prismaError('P2025'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('알 수 없는 코드는 500 이고 봉투는 유지한다', () => {
    const { host, status, json } = capture();

    filter.catch(prismaError('P2003'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect((json.mock.calls[0][0] as ErrorResponse).errors[0].scope).toBe('screen');
  });
});
