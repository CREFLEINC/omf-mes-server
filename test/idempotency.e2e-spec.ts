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
  FAMILY_CONFLICT_CODE,
  IdempotencyModule,
  IdempotencyService,
  requestFingerprint,
} from '../src/common/idempotency';
import type { IdempotencyContext } from '../src/common/idempotency';
import { ConflictException } from '../src/common/errors';
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

    it('⭐ 재생된 응답이 첫 응답과 같다 — 날짜까지', async () => {
      // 재전송이 «다른» 값을 받으면 흡수의 뜻이 없다. 날짜는 jsonb 를 왕복하므로 특히 본다.
      const key = randomUUID();
      const at = new Date('2026-09-02T01:23:45.000Z');

      const first = await service.run(context(key, { a: 1 }), async () => ({ at, n: 7 }));
      const second = await service.run(context(key, { a: 1 }), async () => ({ at, n: 7 }));

      expect(JSON.parse(JSON.stringify(second.body))).toEqual(
        JSON.parse(JSON.stringify(first.body)),
      );
    });

    it('⛔ 같은 키로 다른 내용이면 409 다 — 앞의 응답을 주면 거짓말이 된다', async () => {
      const key = randomUUID();
      await service.run(context(key, { a: 1 }), async () => ({ value: 'x' }));

      // ⛔ 409 의 봉투는 계약 `ConflictResponse` 다 — `errors` 배열이 아니다.
      let caught: ConflictException | undefined;
      try {
        await service.run(context(key, { a: 2 }), async () => ({ value: 'y' }));
      } catch (error) {
        caught = error as ConflictException;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(caught?.conflict).toEqual({
        conflictCause: 'user',
        message: expect.stringContaining('다른 내용'),
      });
    });

    it('⛔ 처리 중이면 409 workerLease 다 — 계열을 안 준 도메인은 `code` 가 «없다»', async () => {
      // `IN_PROGRESS` 는 열린 트랜잭션 안에서만 보이는 상태라 e2e 로는 못 만든다. 기록을
      // 그 상태로 심어 `replay()` 의 두 번째 갈래를 직접 태운다.
      const key = await seedInProgress({ a: 1 });

      const caught = await conflictOf(context(key, { a: 1 }));

      expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(caught?.conflict).toEqual({
        conflictCause: 'workerLease',
        message: expect.stringContaining('처리 중'),
      });
    });

    describe('계열 봉투의 `code`', () => {
      // 결정 — 통보 089. 계약 실측(`a6a87e1`): `Production`·`Quality`·`Shipment`·
      // `StockReinstatement` 넷 다 `code` 가 required 이고 enum 에 `DUPLICATE_KEY`·
      // `INVALID_STATE` 를 둘 다 갖는다. 반면 `app`·`mdm`·`logistics`·`equipment` 의
      // `ConflictResponse` 에는 `code` 프로퍼티 «자체»가 없다.
      const coded = (key: string, body: unknown) => ({
        ...context(key, body),
        conflictCode: FAMILY_CONFLICT_CODE,
      });

      it('⭐ 같은 키·다른 내용 → `code` 가 `DUPLICATE_KEY` 다', async () => {
        const key = randomUUID();
        await service.run(coded(key, { a: 1 }), async () => ({ value: 'x' }));

        const caught = await conflictOf(coded(key, { a: 2 }));

        expect(caught?.conflict).toEqual({
          conflictCause: 'user',
          message: expect.stringContaining('다른 내용'),
          code: 'DUPLICATE_KEY',
        });
      });

      it('⭐ 처리 중 → `code` 가 `INVALID_STATE` 다 (⛔ `CANCEL_IN_PROGRESS` 가 아니다 — shipment 전용이다)', async () => {
        const key = await seedInProgress({ a: 1 });

        const caught = await conflictOf(coded(key, { a: 1 }));

        expect(caught?.conflict).toEqual({
          conflictCause: 'workerLease',
          message: expect.stringContaining('처리 중'),
          code: 'INVALID_STATE',
        });
      });
    });

    /** 지문이 맞는 `IN_PROGRESS` 기록을 심는다 — `replay()` 의 두 번째 갈래를 여는 유일한 길이다. */
    async function seedInProgress(body: unknown): Promise<string> {
      const key = randomUUID();
      await prisma.idempotency_record.create({
        data: {
          idempotency_key: key,
          request_fingerprint: fingerprintOf(body),
          status: 'IN_PROGRESS',
          expires_at: new Date(Date.now() + 3600_000),
        },
      });
      return key;
    }

    async function conflictOf(ctx: IdempotencyContext): Promise<ConflictException | undefined> {
      try {
        await service.run(ctx, async () => ({ value: 'never' }));
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        return error as ConflictException;
      }
      throw new Error('409 가 나야 하는데 통과했다');
    }

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
