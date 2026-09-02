/**
 * 계약이 세 갈래로 선언한 `If-Match` 를 가드가 그대로 가르는지 실제 HTTP 로 본다.
 *   필수 `IfMatchVersion` · 선택 `IfMatchVersionOptional`(오프라인, C-9) · 무선언
 */
import { Controller, INestApplication, Module, Post, Req, Res } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { configureApp } from '../src/app.setup';
import { Contract, ContractModule } from '../src/common/contract';
import { IdempotencyModule } from '../src/common/idempotency';
import { OptimisticLockModule, ifMatchVersion, setEtag } from '../src/common/optimistic-lock';

@Controller()
class ProbeController {
  /** 계약이 If-Match 를 «필수»로 선언한 자리. 본문이 없어 이 검사가 If-Match 만 본다. */
  @Post('mdm/warehouses/:warehouseId\\:deactivate')
  @Contract('POST /mdm/warehouses/{warehouseId}:deactivate')
  required(@Req() req: Request, @Res({ passthrough: true }) res: Response): unknown {
    const version = ifMatchVersion(req);
    if (version !== undefined) setEtag(res, version + 1);
    return { version };
  }

  /** 계약이 «선택»으로 완화한 자리 — 오프라인 큐가 토큰을 안 싣는다(C-9). */
  @Post('maintenance/downtimes/:downtimeId\\:close')
  @Contract('POST /maintenance/downtimes/{downtimeId}:close')
  optional(@Req() req: Request): unknown {
    return { version: ifMatchVersion(req) ?? null };
  }

  /** 계약이 선언하지 않은 자리. */
  @Post('planning/routings/:routingId\\:new-revision')
  @Contract('POST /planning/routings/{routingId}:new-revision')
  none(@Req() req: Request): unknown {
    return { version: ifMatchVersion(req) ?? null };
  }
}

@Module({
  imports: [ContractModule, IdempotencyModule, OptimisticLockModule],
  controllers: [ProbeController],
})
class ProbeModule {}

describe('낙관적 잠금 가드 (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }), ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const key = () => randomUUID();

  describe('필수로 선언한 자리', () => {
    const path = '/api/mdm/warehouses/7:deactivate';

    it('⛔ If-Match 가 없으면 400 이다', async () => {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', key())
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED' });
      expect(response.body.errors[0].message).toContain('If-Match');
    });

    it('⛔ 값이 ETag 형태가 아니면 400 이다', async () => {
      await request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', key())
        .set('If-Match', 'abc')
        .expect(400);
    });

    it('⭐ 값을 파싱해 핸들러에 넘긴다', async () => {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', key())
        .set('If-Match', '"12"')
        .expect(201);

      expect(response.body).toEqual({ version: 12 });
    });

    it('⭐ 핸들러가 새 ETag 를 따옴표 없이 낸다 — 계약이 「그대로 담는다」라 했다', async () => {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', key())
        .set('If-Match', '12')
        .expect(201);

      expect(response.headers.etag).toBe('13');
    });
  });

  describe('선택으로 완화한 자리 — 오프라인 (C-9)', () => {
    const path = '/api/maintenance/downtimes/7:close';

    it('⭐ 없어도 지나간다 — 큐에 쌓인 요청은 토큰을 싣지 않는다', async () => {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', key())
        .expect(201);

      expect(response.body).toEqual({ version: null });
    });

    it('있으면 파싱한다', async () => {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', key())
        .set('If-Match', '3')
        .expect(201);

      expect(response.body).toEqual({ version: 3 });
    });

    it('⛔ 있는데 형태가 틀리면 400 이다 — 완화는 「없어도 된다」이지 「아무거나」가 아니다', async () => {
      await request(app.getHttpServer())
        .post(path)
        .set('Idempotency-Key', key())
        .set('If-Match', 'nope')
        .expect(400);
    });
  });

  it('계약이 선언하지 않은 자리는 헤더를 보지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/planning/routings/1:new-revision')
      .set('Idempotency-Key', key())
      .expect(201);

    expect(response.body).toEqual({ version: null });
  });
});
