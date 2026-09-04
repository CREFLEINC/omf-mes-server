import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ERROR_CODE } from './error-codes';
import { prismaErrorResponse } from './prisma-error';

/** 계약 원본에서 스키마를 읽는다 — 손으로 옮기면 그 순간 드리프트한다. */
function errorResponseValidator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../../../contracts/app-공통.json'), 'utf8'),
  ) as { components: { schemas: Record<string, unknown> } };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'contract', components: contract.components });
  return ajv.compile({ $ref: 'contract#/components/schemas/ErrorResponse' });
}

/** 실측한 모양 그대로 만든다(Prisma 6.19 · PostgreSQL 16). */
function known(code: string, meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('probe', {
    code,
    clientVersion: 'test',
    meta,
  });
}

describe('prismaErrorResponse', () => {
  const validate = errorResponseValidator();

  it('⭐ 없는 FK(P2003)는 500 이 아니라 400 이고, 제약 이름에서 필드를 짚는다', () => {
    const result = prismaErrorResponse(
      known('P2003', { modelName: 'mold', constraint: 'mold_plant_id_fkey' }),
    );

    expect(result?.status).toBe(HttpStatus.BAD_REQUEST);
    expect(result?.errors[0]).toEqual({
      scope: 'field',
      field: 'plantId',
      code: ERROR_CODE.INVALID,
      message: '참조하는 대상이 없습니다.',
    });
    expect(validate({ errors: result?.errors })).toBe(true);
  });

  it('여러 마디 컬럼도 되뽑는다 — 접두 표 이름과 _fkey 만 걷어낸다', () => {
    const result = prismaErrorResponse(
      known('P2003', { modelName: 'item', constraint: 'item_default_lot_storage_uom_id_fkey' }),
    );

    expect(result?.errors[0].field).toBe('defaultLotStorageUomId');
  });

  it('⛔ FK 이름이 기본형이 아니면 필드를 짚지 않는다 — 틀린 칸에 빨간 줄을 긋지 않는다', () => {
    const result = prismaErrorResponse(
      known('P2003', { modelName: 'mold', constraint: 'fk_something_else' }),
    );

    expect(result?.status).toBe(HttpStatus.BAD_REQUEST);
    expect(result?.errors[0]).toEqual({
      scope: 'screen',
      code: ERROR_CODE.INVALID,
      message: '참조하는 대상이 없습니다.',
    });
  });

  it('⭐ 유일 위반(P2002)은 유일 «범위»를 통째로 싣는다 — 공유계약 A-1', () => {
    const result = prismaErrorResponse(
      known('P2002', { modelName: 'mold', target: ['plant_id', 'mold_code'] }),
    );

    expect(result?.status).toBe(HttpStatus.BAD_REQUEST);
    expect(result?.errors[0]).toEqual({
      scope: 'field',
      field: 'plantId',
      code: ERROR_CODE.UNIQUE_VIOLATION,
      uniqueScope: ['plantId', 'moldCode'],
      message: '이미 있는 값입니다.',
    });
    expect(validate({ errors: result?.errors })).toBe(true);
  });

  it('target 이 컬럼 배열이 아니면 배너로 내린다', () => {
    const result = prismaErrorResponse(known('P2002', { target: 'uq_mold' }));

    expect(result?.errors[0]).toEqual({
      scope: 'screen',
      code: ERROR_CODE.UNIQUE_VIOLATION,
      message: '이미 있는 값입니다.',
    });
  });

  it('없는 행(P2025)은 404 다', () => {
    const result = prismaErrorResponse(known('P2025', { cause: 'No record was found.' }));

    expect(result?.status).toBe(HttpStatus.NOT_FOUND);
    expect(result?.errors[0].code).toBe('NOT_FOUND');
    expect(validate({ errors: result?.errors })).toBe(true);
  });

  it('⛔ 다루지 않는 Prisma 코드와 남의 오류는 손대지 않는다 — 500 으로 남는다', () => {
    expect(prismaErrorResponse(known('P2000', {}))).toBeUndefined();
    expect(prismaErrorResponse(new Error('그냥 오류'))).toBeUndefined();
    // CHECK 위반은 «알려진» 오류가 아니라 여기 오지도 않는다 — 우리 버그라 500 이 맞다.
    expect(prismaErrorResponse(new Prisma.PrismaClientUnknownRequestError('check', { clientVersion: 'test' }))).toBeUndefined();
  });
});
