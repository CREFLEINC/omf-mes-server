import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('GET /api/health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // 운영 부팅(main.ts)과 같은 함수를 쓴다 — 프리픽스를 따로 적으면 둘이 어긋난다.
    configureApp(app, 'api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('실제 DB 에 붙어 200 과 상태를 준다', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(response.body).toMatchObject({ status: 'ok', db: 'up' });
  });
});
