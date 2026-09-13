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

    /**
     * ⛔ #612 실측의 «정체». 목록이 비면 `enableCors` 를 안 부르고, 그러면 NestJS 가
     * `OPTIONS` 핸들러를 달지 않아 라우터가 404 를 낸다. 브라우저 쪽에는 CORS 오류로만
     * 보이고 서버 로그에는 아무것도 안 남아 원인이 드러나지 않는다 — 그 인과를 고정한다.
     */
    it('⛔ preflight 가 404 다 — 라우터에 OPTIONS 핸들러가 없다', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/probe/etag')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'PUT');

      expect(response.status).toBe(404);
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

    /**
     * ⭐ `Authorization`·`X-Worker-No` 가 빠져 있어 현장 셸의 교차 오리진 호출이 전부
     * 막혔다(#612). `allowedHeaders` 를 «명시»하면 cors 패키지는 요청 헤더를 반사하지
     * 않고 이 목록만 돌려주므로, 서버가 읽는 헤더가 하나라도 빠지면 그대로 차단된다.
     */
    const CONTRACT_HEADERS = [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'x-worker-no',
    ];

    it('⭐ preflight 가 계약이 쓰는 요청 헤더를 모두 허용한다', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/probe/etag')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'PUT')
        .set('Access-Control-Request-Headers', CONTRACT_HEADERS.join(','));

      expect(response.status).toBeLessThan(300);
      const allowed = String(response.headers['access-control-allow-headers']).toLowerCase();
      for (const header of CONTRACT_HEADERS) {
        expect(allowed).toContain(header);
      }
    });

    // ⛔ 허용 목록은 «허용 목록»이어야 한다. `allowedHeaders` 를 지우면 cors 패키지가
    //    요청한 헤더를 그대로 반사해 무엇이든 통과하는데, 위 테스트는 그것을 못 잡는다.
    it('⛔ 목록에 없는 헤더는 허용하지 않는다', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/probe/etag')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'x-not-in-contract');

      // ⚠ 헤더가 «있는지»부터 본다 — 없으면 String(undefined) 가 'undefined' 가 되어
      //    아래 단언이 조용히 통과한다.
      expect(response.headers['access-control-allow-headers']).toBeDefined();
      const allowed = String(response.headers['access-control-allow-headers']).toLowerCase();
      expect(allowed).not.toContain('x-not-in-contract');
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
