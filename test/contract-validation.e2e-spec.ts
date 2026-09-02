import { Body, Controller, Get, INestApplication, Module, Param, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApp } from '../src/app.setup';
import { Contract, ContractModule } from '../src/common/contract';
import { ERROR_CODE } from '../src/common/errors';

/**
 * AppModule 을 쓰지 않는다 — PrismaService 가 onModuleInit 에서 $connect() 하므로
 * 계약 검증을 보는 검사가 DB 가용성에 매이게 된다. ContractModule 만 있으면 가드가 선다.
 */
@Controller()
class ProbeController {
  @Post('app/roles')
  @Contract('POST /app/roles')
  createRole(@Body() body: unknown): unknown {
    return { received: body };
  }

  @Get('app/approval-routes')
  @Contract('GET /app/approval-routes')
  listRoutes(@Query() query: unknown): unknown {
    return { query };
  }

  @Get('app/roles/:roleId')
  @Contract('GET /app/roles/{roleId}')
  getRole(@Param('roleId') roleId: unknown): unknown {
    return { roleId, type: typeof roleId };
  }

  /** 계약 밖의 자리. 가드가 그냥 지나가야 한다. */
  @Get('probe/unbound')
  unbound(): unknown {
    return { ok: true };
  }
}

@Module({ imports: [ContractModule], controllers: [ProbeController] })
class ProbeModule {}

describe('계약 검증 가드 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('계약을 만족하는 요청은 핸들러까지 간다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/app/roles')
      .send({ roleCode: 'ROLE_X', roleName: '역할' })
      .expect(201);

    expect(response.body).toEqual({ received: { roleCode: 'ROLE_X', roleName: '역할' } });
  });

  it('필수 누락은 400 과 ErrorResponse 봉투로 막힌다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/app/roles')
      .send({ roleCode: 'ROLE_X' })
      .expect(400);

    expect(response.body).toEqual({
      errors: [
        {
          scope: 'field',
          field: 'roleName',
          code: ERROR_CODE.REQUIRED,
          message: expect.any(String),
        },
      ],
    });
  });

  it('여러 칸이 틀리면 한 응답에 함께 담긴다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/app/roles')
      .send({})
      .expect(400);

    expect(response.body.errors.map((error: { field: string }) => error.field).sort()).toEqual([
      'roleCode',
      'roleName',
    ]);
  });

  it('질의 enum 위반이 막힌다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/approval-routes?approvalTypeCode=없는유형')
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({
      field: 'approvalTypeCode',
      code: ERROR_CODE.INVALID,
    });
  });

  it('경로 파라미터가 숫자가 아니면 막힌다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/roles/숫자아님')
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'roleId', code: ERROR_CODE.INVALID });
  });

  it('⭐ 질의 문자열이 계약이 선언한 타입으로 핸들러에 닿는다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/approval-routes?businessUnitId=10&activeOnly=true&page=2')
      .expect(200);

    expect(response.body.query).toEqual({ businessUnitId: 10, activeOnly: true, page: 2 });
  });

  it('⭐ 경로 파라미터도 계약이 선언한 타입으로 닿는다', async () => {
    const response = await request(app.getHttpServer()).get('/api/app/roles/7').expect(200);

    expect(response.body).toEqual({ roleId: 7, type: 'number' });
  });

  it('@Contract 가 없는 핸들러는 그냥 지나간다', async () => {
    await request(app.getHttpServer()).get('/api/probe/unbound').expect(200, { ok: true });
  });
});
