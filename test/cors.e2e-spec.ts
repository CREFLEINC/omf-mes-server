/**
 * 브라우저가 다른 오리진에서 부를 수 있는가.
 *
 * ⭐ `ETag` 노출이 이 파일의 본체다 — 빠뜨리면 화면이 낙관적 잠금 토큰을 못 읽어
 * 모든 수정이 `If-Match` 없이 나가고, 도메인 전체의 편집이 죽는다.
 */
import { Controller, Get, INestApplication, Module, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';

import { configureApp } from '../src/app.setup';
import { corsOrigins } from '../src/common/http/cors';

const ALLOWED = 'http://192.168.1.190:5173';

@Controller('probe')
class CorsProbeController {
  @Get('etag')
  etag(@Res({ passthrough: true }) response: Response): unknown {
    response.setHeader('ETag', '7');
    return { ok: true };
  }
}

@Module({ controllers: [CorsProbeController] })
class ProbeModule {}

async function boot(origins: string | undefined): Promise<INestApplication> {
  if (origins === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = origins;

  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, 'api');
  await app.init();
  return app;
}

describe('CORS (e2e)', () => {
  const original = process.env.CORS_ORIGINS;

  afterAll(() => {
    if (original === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = original;
  });

  describe('목록이 없으면 아무것도 열지 않는다', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await boot(undefined);
    });
    afterAll(async () => {
      await app.close();
    });

    it('⛔ Access-Control-Allow-Origin 을 안 준다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/etag')
        .set('Origin', ALLOWED)
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('목록에 있으면 연다', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await boot(`${ALLOWED}, http://localhost:5173`);
    });
    afterAll(async () => {
      await app.close();
    });

    it('⭐ 허용 오리진에 «정확한 값»을 돌려준다 — 쿠키를 쓰므로 와일드카드는 불가', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/etag')
        .set('Origin', ALLOWED)
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('⭐⭐ ETag 를 노출한다 — 없으면 화면이 낙관적 잠금 토큰을 못 읽는다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/etag')
        .set('Origin', ALLOWED)
        .expect(200);

      expect(response.headers['access-control-expose-headers']).toContain('ETag');
    });

    it('⭐ preflight 가 계약이 쓰는 요청 헤더 셋을 허용한다', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/probe/etag')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'PUT')
        .set('Access-Control-Request-Headers', 'content-type,idempotency-key,if-match');

      expect(response.status).toBeLessThan(300);
      const allowed = String(response.headers['access-control-allow-headers']).toLowerCase();
      for (const header of ['content-type', 'idempotency-key', 'if-match']) {
        expect(allowed).toContain(header);
      }
    });

    it('⛔ 목록 밖 오리진은 열지 않는다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/probe/etag')
        .set('Origin', 'http://evil.example')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('목록 파싱', () => {
    it.each([
      ['', []],
      ['  ', []],
      ['http://a', ['http://a']],
      [' http://a , http://b ,', ['http://a', 'http://b']],
    ])('%s → %s', (raw, expected) => {
      expect(corsOrigins(raw)).toEqual(expected);
    });
  });
});
