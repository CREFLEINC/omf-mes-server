import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  PopWorkStartFixture,
  resetPopWorkStartState,
  seedPopWorkStartFixture,
  TERMINAL_CODE,
  WORKER_NO,
} from '../prisma/fixtures/pop-work-start';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TerminalAuthService } from '../src/auth/terminal-auth.service';
import { WORKER_NO_HEADER } from '../src/auth/terminal-auth.decorators';
import { IDEMPOTENCY_KEY_HEADER } from '../src/common/idempotency/idempotency.decorators';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'api';

/**
 * 생산실적 등록을 실제 앱·실제 DB로 통과시킨다.
 *
 * 여기서만 증명되는 것: 채번이 실제 카운터를 돌려 번호를 만드는지, 멱등 키 UNIQUE가
 * 재전송을 막고 앱이 그걸 200으로 바꿔 주는지, 세션 4M 승계가 FK를 통과하는지.
 */
describe('POP 생산실적 등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fixture: PopWorkStartFixture;
  let token: string;
  let workSessionId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app, PREFIX);
    await app.init();

    prisma = app.get(PrismaService);
    fixture = await seedPopWorkStartFixture(prisma);
    token = (await app.get(TerminalAuthService).issueToken(TERMINAL_CODE)).accessToken;
  });

  afterAll(async () => {
    await resetPopWorkStartState(prisma);
    await app.close();
  });

  // 실적은 열린 세션에만 붙는다 — 매 테스트를 「막 시작한 작업」에서 출발시킨다.
  beforeEach(async () => {
    await resetPopWorkStartState(prisma);

    const started = await request(app.getHttpServer())
      .post(`/${PREFIX}/pop/work-orders/${fixture.workOrderId}/start`)
      .auth(token, { type: 'bearer' })
      .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
      .set(WORKER_NO_HEADER, WORKER_NO)
      .send({})
      .expect(201);

    workSessionId = started.body.workSessionId;
  });

  const post = (idempotencyKey: string = randomUUID()) =>
    request(app.getHttpServer())
      .post(`/${PREFIX}/pop/work-sessions/${workSessionId}/results`)
      .auth(token, { type: 'bearer' })
      .set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);

  describe('등록', () => {
    it('세션의 4M을 승계해 실적을 남긴다', async () => {
      const response = await post().send({ goodQty: 300 }).expect(201);

      expect(response.body).toMatchObject({
        resultSequence: 1,
        goodQty: 300,
        statusCode: 'CONFIRMED',
        replayed: false,
      });

      const result = await prisma.production_result.findUniqueOrThrow({
        where: { production_result_id: BigInt(response.body.productionResultId) },
      });
      expect(result.work_session_id).toBe(BigInt(workSessionId));
      expect(result.shift_id).toBe(fixture.shiftId);
      expect(result.terminal_id).not.toBeNull();
      expect(result.good_qty.toNumber()).toBe(300);
    });

    it('채번규칙 패턴대로 번호를 만든다', async () => {
      const response = await post().send({ goodQty: 10 }).expect(201);

      // PR-{YYMMDD}-{SEQ4}
      expect(response.body.productionResultNo).toMatch(/^PR-\d{6}-\d{4}$/);
    });

    it('연속 등록은 번호도 회차도 이어진다', async () => {
      const first = await post().send({ goodQty: 10 }).expect(201);
      const second = await post().send({ goodQty: 20 }).expect(201);

      expect(second.body.resultSequence).toBe(first.body.resultSequence + 1);
      expect(second.body.productionResultNo).not.toBe(first.body.productionResultNo);
    });

    // 초과분은 추가 생산LOT 발행으로 처리하는 것이 확정 설계다(도식 02 태그 464:6653).
    it('지시수량을 넘겨도 막지 않는다', async () => {
      await post().send({ goodQty: 999999 }).expect(201);
    });

    it('발생 시각을 보내면 그 시각으로 남긴다', async () => {
      const occurredAt = '2026-07-28T09:30:00.000Z';

      const response = await post().send({ goodQty: 10, occurredAt }).expect(201);

      expect(new Date(response.body.occurredAt).toISOString()).toBe(occurredAt);
    });
  });

  describe('거부', () => {
    it('멱등 키 헤더가 없으면 400', async () => {
      await request(app.getHttpServer())
        .post(`/${PREFIX}/pop/work-sessions/${workSessionId}/results`)
        .auth(token, { type: 'bearer' })
        .send({ goodQty: 10 })
        .expect(400);
    });

    it('수량이 0 이하면 400', async () => {
      await post().send({ goodQty: 0 }).expect(400);
      await post().send({ goodQty: -5 }).expect(400);
    });

    it('DTO에 없는 필드는 400 (forbidNonWhitelisted)', async () => {
      await post().send({ goodQty: 10, defectQty: 3 }).expect(400);
    });

    it('토큰 없이는 401', async () => {
      await request(app.getHttpServer())
        .post(`/${PREFIX}/pop/work-sessions/${workSessionId}/results`)
        .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
        .send({ goodQty: 10 })
        .expect(401);
    });

    it('없는 세션은 404', async () => {
      await request(app.getHttpServer())
        .post(`/${PREFIX}/pop/work-sessions/99999999/results`)
        .auth(token, { type: 'bearer' })
        .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
        .send({ goodQty: 10 })
        .expect(404);
    });

    it('닫힌 세션에는 올릴 수 없다', async () => {
      await prisma.work_session.update({
        where: { work_session_id: BigInt(workSessionId) },
        data: { status_code: 'CLOSED', ended_at: new Date() },
      });

      await post().send({ goodQty: 10 }).expect(403);
    });
  });

  describe('멱등 재전송', () => {
    it('같은 키로 다시 보내면 처음 만든 실적을 그대로 돌려준다', async () => {
      const key = randomUUID();

      const first = await post(key).send({ goodQty: 300 }).expect(201);
      const retry = await post(key).send({ goodQty: 300 }).expect(201);

      expect(first.body.replayed).toBe(false);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.productionResultId).toBe(first.body.productionResultId);

      // 재전송이 새 실적을 만들면 생산량이 그대로 부풀려진다.
      const count = await prisma.production_result.count({
        where: { work_order_id: fixture.workOrderId },
      });
      expect(count).toBe(1);
    });

    it('세션이 닫힌 뒤 도착한 재전송도 처음 만든 실적을 돌려준다', async () => {
      const key = randomUUID();
      const first = await post(key).send({ goodQty: 300 }).expect(201);

      await prisma.work_session.update({
        where: { work_session_id: BigInt(workSessionId) },
        data: { status_code: 'CLOSED', ended_at: new Date() },
      });

      const retry = await post(key).send({ goodQty: 300 }).expect(201);
      expect(retry.body.productionResultId).toBe(first.body.productionResultId);
      expect(retry.body.replayed).toBe(true);
    });

    it('다른 세션에 쓰인 키면 409', async () => {
      const key = randomUUID();
      await post(key).send({ goodQty: 10 }).expect(201);

      // 세션을 새로 열고 같은 키를 다시 쓴다.
      await prisma.work_session.update({
        where: { work_session_id: BigInt(workSessionId) },
        data: { status_code: 'CLOSED', ended_at: new Date() },
      });
      const restarted = await request(app.getHttpServer())
        .post(`/${PREFIX}/pop/work-orders/${fixture.workOrderId}/start`)
        .auth(token, { type: 'bearer' })
        .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
        .set(WORKER_NO_HEADER, WORKER_NO)
        .send({})
        .expect(201);

      await request(app.getHttpServer())
        .post(`/${PREFIX}/pop/work-sessions/${restarted.body.workSessionId}/results`)
        .auth(token, { type: 'bearer' })
        .set(IDEMPOTENCY_KEY_HEADER, key)
        .send({ goodQty: 10 })
        .expect(409);
    });
  });
});
