import { Controller, Get, HttpStatus, INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApp } from '../src/app.setup';
import { ContractException, ERROR_CODE, INTERNAL_ERROR_CODE } from '../src/common/errors';

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

  it('처리되지 않은 예외가 내부 메시지를 흘리지 않는다', async () => {
    const response = await request(app.getHttpServer()).get('/api/probe/boom').expect(500);

    expect(response.body).toEqual({
      errors: [{ scope: 'screen', code: INTERNAL_ERROR_CODE, message: '요청을 처리하지 못했습니다.' }],
    });
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
  });
});
