/**
 * 실제 PostgreSQL 에 대고 돈다. 멱등은 «두 번째 요청이 무엇을 보는가」이고 그것은
 * DB 상태다 — 흉내로는 「두 번 처리하지 않았다」를 말할 수 없다.
 */
import { Controller, HttpStatus, INestApplication, Module, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { configureApp } from '../src/app.setup';
import { Contract, ContractModule } from '../src/common/contract';
import {
  IdempotencyModule,
  IdempotencyService,
  requestFingerprint,
} from '../src/common/idempotency';
import { ContractException } from '../src/common/errors';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

/** 계약이 Idempotency-Key 를 요구하는 자리와 안 하는 자리를 하나씩 잡는다. */
@Controller()
class ProbeController {
  @Post('app/roles')
  @Contract('POST /app/roles')
  requiresKey(): unknown {
    return { ok: true };
  }

  @Post('probe/free')
  free(): unknown {
    return { ok: true };
  }
}

@Module({ imports: [ContractModule, PrismaModule, IdempotencyModule], controllers: [ProbeController] })
class ProbeModule {}

describe('멱등 (실 DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: IdempotencyService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }), ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    service = app.get(IdempotencyService);
  });

  afterAll(async () => {
    await prisma.idempotency_record.deleteMany({});
    await app.close();
  });

  describe('헤더 강제 — 계약이 선언한 자리만', () => {
    it('⛔ 계약이 요구하는데 없으면 400 이다', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/app/roles')
        .send({ roleCode: 'R', roleName: '역할' })
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED' });
      expect(response.body.errors[0].message).toContain('Idempotency-Key');
    });

    it('⛔ uuid 가 아니면 400 이다 — 계약이 format: uuid 로 선언했다', async () => {
      await request(app.getHttpServer())
        .post('/api/app/roles')
        .set('Idempotency-Key', 'not-a-uuid')
        .send({ roleCode: 'R', roleName: '역할' })
        .expect(400);
    });

    it('uuid 면 지나간다', async () => {
      await request(app.getHttpServer())
        .post('/api/app/roles')
        .set('Idempotency-Key', randomUUID())
        .send({ roleCode: 'R', roleName: '역할' })
        .expect(201);
    });

    it('⭐ 계약 검증이 먼저 돈다 — 본문이 틀리고 키도 없으면 «본문» 오류가 나온다', async () => {
      // app.module 이 ContractModule 을 IdempotencyModule «앞»에 둔다. Nest 는 APP_GUARD 를
      // 등록 순서대로 돌리므로 그 순서가 곧 이 동작이다. 뒤집히면 필드 단위 오류가 사라진다.
      const response = await request(app.getHttpServer())
        .post('/api/app/roles')
        .send({ password: 'x' })
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ scope: 'field', field: 'roleCode' });
    });

    it('계약이 요구하지 않는 자리는 헤더 없이도 지나간다', async () => {
      await request(app.getHttpServer()).post('/api/probe/free').expect(201);
    });
  });

  describe('흡수', () => {
    const fingerprintOf = (body: unknown) => requestFingerprint('POST /probe', body);
    const context = (key: string, body: unknown) => ({
      key,
      fingerprint: fingerprintOf(body),
      successStatus: 201,
    });

    it('처음 처리하면 일을 하고 결과를 준다', async () => {
      const key = randomUUID();
      let ran = 0;

      const outcome = await service.run(context(key, { a: 1 }), async () => {
        ran += 1;
        return { value: 'first' };
      });

      expect(ran).toBe(1);
      expect(outcome).toEqual({ replayed: false, status: 201, body: { value: 'first' } });
    });

    it('⭐ 같은 키·같은 내용이면 다시 하지 않고 앞의 응답을 준다', async () => {
      const key = randomUUID();
      let ran = 0;
      const work = async (): Promise<{ value: string }> => {
        ran += 1;
        return { value: `run-${ran}` };
      };

      await service.run(context(key, { a: 1 }), work);
      const second = await service.run(context(key, { a: 1 }), work);

      expect(ran).toBe(1);
      expect(second.replayed).toBe(true);
      expect(second.body).toEqual({ value: 'run-1' });
    });

    it('⛔ 같은 키로 다른 내용이면 409 다 — 앞의 응답을 주면 거짓말이 된다', async () => {
      const key = randomUUID();
      await service.run(context(key, { a: 1 }), async () => ({ value: 'x' }));

      // ContractException 의 message 는 ErrorItem 문구가 아니다 — 봉투를 본다.
      let caught: ContractException | undefined;
      try {
        await service.run(context(key, { a: 2 }), async () => ({ value: 'y' }));
      } catch (error) {
        caught = error as ContractException;
      }

      expect(caught).toBeInstanceOf(ContractException);
      expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(caught?.errors[0].message).toContain('다른 내용');
    });

    it('⛔ 일이 실패하면 기록도 남지 않는다 — 재시도가 막히면 안 된다', async () => {
      const key = randomUUID();

      await expect(
        service.run(context(key, { a: 1 }), async () => {
          throw new Error('업무 실패');
        }),
      ).rejects.toThrow('업무 실패');

      expect(
        await prisma.idempotency_record.findUnique({ where: { idempotency_key: key } }),
      ).toBeNull();
    });

    it('⭐ 같은 키가 동시에 와도 한 번만 처리된다', async () => {
      const key = randomUUID();
      let ran = 0;

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          service.run(context(key, { a: 1 }), async () => {
            ran += 1;
            return { value: 'once' };
          }),
        ),
      );

      expect(ran).toBe(1);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length).toBeGreaterThan(0);
      // 나머지는 처리 중이라 409 이거나, 끝난 뒤라 흡수된다 — 어느 쪽이든 두 번 하지 않는다.
    });
  });

  describe('지문', () => {
    it('키 순서가 달라도 같은 요청이다', () => {
      expect(requestFingerprint('POST /x', { a: 1, b: 2 })).toBe(
        requestFingerprint('POST /x', { b: 2, a: 1 }),
      );
    });

    it('오퍼레이션이 다르면 다른 지문이다', () => {
      expect(requestFingerprint('POST /x', { a: 1 })).not.toBe(requestFingerprint('POST /y', { a: 1 }));
    });
  });
});
