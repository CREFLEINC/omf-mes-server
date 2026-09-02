import { Controller, Get, HttpStatus, INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApp } from '../src/app.setup';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  INTERNAL_ERROR_CODE,
} from '../src/common/errors';

/**
 * AppModule 을 쓰지 않는다 — PrismaService 가 onModuleInit 에서 $connect() 하므로
 * 오류 봉투를 보는 검사가 DB 가용성에 매이게 된다. 여기서 보는 것은 configureApp 이
 * 필터를 실제로 다는가이지 도메인 동작이 아니다.
 */
@Controller('probe')
class ProbeController {
  @Get('contract')
  contract(): never {
    throw new ContractException(HttpStatus.CONFLICT, [
      { scope: 'field', field: 'orderQty', code: ERROR_CODE.RANGE, message: '1 이상이어야 합니다.' },
    ]);
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException('erpSync', '기간계 재동기화가 같은 자료를 갱신했습니다.');
  }

  @Get('boom')
  boom(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.7:5432');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('오류 봉투 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // 필터가 5xx 를 스택과 함께 로그로 남긴다 — 그 출력이 테스트 결과를 덮지 않게 막는다.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    // 운영 부팅(main.ts)과 같은 함수를 쓴다.
    configureApp(app, 'api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('없는 경로가 ErrorResponse 봉투로 404 를 낸다', async () => {
    const response = await request(app.getHttpServer()).get('/api/없는경로').expect(404);

    expect(response.body).toEqual({
      errors: [{ scope: 'screen', code: 'NOT_FOUND', message: expect.any(String) }],
    });
  });

  it('configureApp 을 거친 앱이 필터를 달고 있다 — ContractException 이 봉투로 나간다', async () => {
    const response = await request(app.getHttpServer()).get('/api/probe/contract').expect(409);

    expect(response.body).toEqual({
      errors: [
        { scope: 'field', field: 'orderQty', code: ERROR_CODE.RANGE, message: '1 이상이어야 합니다.' },
      ],
    });
  });

  it('⭐ 409 는 «다른» 봉투로 나간다 — 계약 ConflictResponse 를 스키마로 대조한다', async () => {
    const response = await request(app.getHttpServer()).get('/api/probe/conflict').expect(409);

    // ⛔ 계약 원본에서 스키마를 읽는다 — 손으로 옮겨 적으면 그 순간 드리프트한다.
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
    ) as { components: { schemas: Record<string, unknown> } };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: 'contract', components: contract.components });
    const validate = ajv.compile({ $ref: 'contract#/components/schemas/ConflictResponse' });

    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body).toEqual({
      conflictCause: 'erpSync',
      message: '기간계 재동기화가 같은 자료를 갱신했습니다.',
    });
    // ⛔ 여기가 이 검사의 핵심이다 — errors 배열로 싸면 화면이 원인을 못 찾는다.
    expect(response.body).not.toHaveProperty('errors');
  });

  it('⛔ 검증기가 실제로 거른다 — 위 검사가 헛통과가 아님을 보인다', () => {
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
    ) as { components: { schemas: Record<string, unknown> } };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: 'contract', components: contract.components });
    const validate = ajv.compile({ $ref: 'contract#/components/schemas/ConflictResponse' });

    // 종전 봉투(`{ errors: [...] }`)는 이 스키마를 만족하지 못한다.
    expect(validate({ errors: [{ scope: 'screen', code: 'STALE_VERSION', message: 'x' }] })).toBe(
      false,
    );
    expect(validate({ conflictCause: '없는원인', message: 'x' })).toBe(false);
  });

  it('처리되지 않은 예외가 내부 메시지를 흘리지 않는다', async () => {
    const response = await request(app.getHttpServer()).get('/api/probe/boom').expect(500);

    expect(response.body).toEqual({
      errors: [{ scope: 'screen', code: INTERNAL_ERROR_CODE, message: '요청을 처리하지 못했습니다.' }],
    });
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
  });
});
