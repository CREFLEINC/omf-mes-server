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
  WORK_ORDER_NO,
} from '../prisma/fixtures/pop-work-start';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { WORKER_NO_HEADER } from '../src/auth/terminal-auth.decorators';
import { IDEMPOTENCY_KEY_HEADER } from '../src/common/idempotency/idempotency.decorators';
import { TerminalAuthService } from '../src/auth/terminal-auth.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'api';
const WORK_ORDERS = `/${PREFIX}/pop/work-orders`;

/**
 * 「작업 시작」을 실제 앱·실제 DB로 통과시킨다.
 *
 * 단위 테스트는 Prisma를 목킹해 분기만 본다 — 중첩 관계 필터가 실제로 도는지,
 * 트랜잭션 3종이 FK·NOT NULL을 통과하는지는 여기서만 증명된다.
 */
describe('POP 작업 시작 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fixture: PopWorkStartFixture;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app, PREFIX);
    await app.init();

    prisma = app.get(PrismaService);
    fixture = await seedPopWorkStartFixture(prisma);

    // 토큰은 실제 발급 경로로 받는다 — 서명 형식이 어긋나면 여기서 드러난다.
    token = (await app.get(TerminalAuthService).issueToken(TERMINAL_CODE)).accessToken;
  });

  afterAll(async () => {
    await resetPopWorkStartState(prisma);
    await app.close();
  });

  // 각 테스트가 「막 배포된 W/O」에서 시작하도록 되돌린다.
  beforeEach(() => resetPopWorkStartState(prisma));

  const asTerminal = () => request(app.getHttpServer()).get(WORK_ORDERS).auth(token, { type: 'bearer' });

  // 재전송 검증 외에는 매번 새 키를 쓴다 — 실제 클라이언트가 요청마다 UUID를 만드는 것과 같다.
  const startRequest = (idempotencyKey: string = randomUUID()) =>
    request(app.getHttpServer())
      .post(`${WORK_ORDERS}/${fixture.workOrderId}/start`)
      .auth(token, { type: 'bearer' })
      .set(IDEMPOTENCY_KEY_HEADER, idempotencyKey);

  describe('인증', () => {
    it('토큰 없이는 401', async () => {
      await request(app.getHttpServer()).get(WORK_ORDERS).expect(401);
    });

    it('망가진 토큰은 401', async () => {
      await request(app.getHttpServer())
        .get(WORK_ORDERS)
        .auth('not-a-token', { type: 'bearer' })
        .expect(401);
    });
  });

  describe(`GET ${WORK_ORDERS}`, () => {
    it('배포된 작업지시를 돌려준다', async () => {
      const response = await asTerminal().expect(200);

      const found = response.body.items.find(
        (item: { workOrderNo: string }) => item.workOrderNo === WORK_ORDER_NO,
      );
      expect(found).toMatchObject({
        statusCode: 'RELEASED',
        processCode: 'INJECTION',
        uomCode: 'EA',
        hasOpenSession: false,
      });
      // bigint는 문자열로 나가야 한다 — 숫자로 바꾸면 2^53 초과에서 정밀도가 깨진다.
      expect(typeof found.workOrderId).toBe('string');
    });

    it('단말이 시작할 수 없는 공정을 지정하면 403', async () => {
      await asTerminal().query({ processCode: 'PACKING' }).expect(403);
    });

    it('DTO에 없는 쿼리 파라미터는 400 (forbidNonWhitelisted)', async () => {
      await asTerminal().query({ nosuch: 'x' }).expect(400);
    });
  });

  describe(`POST ${WORK_ORDERS}/:id/start`, () => {
    it('세션·작업자 귀속·시작 이벤트를 함께 남기고 작업지시를 작업중으로 올린다', async () => {
      const response = await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);

      expect(response.body).toMatchObject({
        sessionNo: 1,
        statusCode: 'OPEN',
        worker: { workerNo: WORKER_NO },
        shift: { shiftCode: 'DAY' },
        warnings: [],
      });

      const session = await prisma.work_session.findUniqueOrThrow({
        where: { work_session_id: BigInt(response.body.workSessionId) },
        include: { work_session_worker: true, work_session_event: true },
      });
      expect(session.status_code).toBe('OPEN');
      expect(session.shift_id).toBe(fixture.shiftId);
      expect(session.work_session_worker).toHaveLength(1);
      expect(session.work_session_event.map((event) => event.event_type_code)).toEqual(['START']);

      const workOrder = await prisma.work_order.findUniqueOrThrow({
        where: { work_order_id: fixture.workOrderId },
      });
      expect(workOrder.status_code).toBe('IN_PROGRESS');
    });

    it('시작한 뒤 목록에 hasOpenSession이 선다', async () => {
      await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);

      const response = await asTerminal().expect(200);
      const found = response.body.items.find(
        (item: { workOrderNo: string }) => item.workOrderNo === WORK_ORDER_NO,
      );
      expect(found).toMatchObject({ statusCode: 'IN_PROGRESS', hasOpenSession: true });
    });

    it('같은 작업지시를 두 번 시작하면 409', async () => {
      await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);
      await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(409);

      const sessions = await prisma.work_session.count({
        where: { work_order_id: fixture.workOrderId },
      });
      expect(sessions).toBe(1);
    });

    it('사번 헤더가 없으면 400이고 세션을 만들지 않는다', async () => {
      await startRequest().send({}).expect(400);

      const sessions = await prisma.work_session.count({
        where: { work_order_id: fixture.workOrderId },
      });
      expect(sessions).toBe(0);
    });

    it('등록되지 않은 사번은 403', async () => {
      await startRequest().set(WORKER_NO_HEADER, 'NO-SUCH-WORKER').send({}).expect(403);
    });

    it('없는 작업지시는 404', async () => {
      await request(app.getHttpServer())
        .post(`${WORK_ORDERS}/99999999/start`)
        .auth(token, { type: 'bearer' })
        .set(IDEMPOTENCY_KEY_HEADER, randomUUID())
        .set(WORKER_NO_HEADER, WORKER_NO)
        .send({})
        .expect(404);
    });

    it('멱등 키 헤더가 없으면 400이고 세션을 만들지 않는다', async () => {
      await request(app.getHttpServer())
        .post(`${WORK_ORDERS}/${fixture.workOrderId}/start`)
        .auth(token, { type: 'bearer' })
        .set(WORKER_NO_HEADER, WORKER_NO)
        .send({})
        .expect(400);

      const sessions = await prisma.work_session.count({
        where: { work_order_id: fixture.workOrderId },
      });
      expect(sessions).toBe(0);
    });

    it('없는 근무조를 지정하면 404', async () => {
      await startRequest()
        .set(WORKER_NO_HEADER, WORKER_NO)
        .send({ shiftCode: 'NO-SUCH-SHIFT' })
        .expect(404);
    });

    it('배포되지 않은 작업지시는 403', async () => {
      await prisma.work_order.update({
        where: { work_order_id: fixture.workOrderId },
        data: { status_code: 'PLANNED' },
      });

      await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(403);
    });
  });

  /**
   * 오프라인 버퍼링(결정 17) 때문에 재전송이 실제로 일어난다. 재전송이 새 세션을 열면
   * 한 작업지시에 세션이 둘 생기고, 그 뒤 실적이 어디 붙었느냐로 집계가 갈린다.
   */
  describe('멱등 재전송 — Idempotency-Key', () => {
    it('같은 키로 다시 보내면 처음 연 세션을 그대로 돌려준다', async () => {
      const key = randomUUID();

      const first = await startRequest(key).set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);
      const retry = await startRequest(key).set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);

      expect(first.body.replayed).toBe(false);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.workSessionId).toBe(first.body.workSessionId);

      const sessions = await prisma.work_session.count({
        where: { work_order_id: fixture.workOrderId },
      });
      expect(sessions).toBe(1);
    });

    // 오프라인에서 돌아온 단말은 자기 요청이 반영됐는지 모른 채 재전송한다.
    it('재전송은 「이미 진행 중」 409로 떨어지지 않는다', async () => {
      const key = randomUUID();
      await startRequest(key).set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);

      // 다른 키로 보내면 중복 시작이라 409, 같은 키면 멱등이라 201.
      await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(409);
      await startRequest(key).set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);
    });
  });

  describe('자격 강제 — 운영정책이 정한다', () => {
    const POLICY = 'WORKER_QUALIFICATION_ENFORCEMENT';

    const setPolicy = (value: string) =>
      prisma.operation_policy.create({
        data: {
          policy_code: POLICY,
          process_id: fixture.processId,
          value_text: value,
          effective_from: new Date('2026-01-01'),
        },
      });

    afterEach(() =>
      prisma.operation_policy.deleteMany({
        where: { policy_code: POLICY, process_id: fixture.processId },
      }),
    );

    it('정책이 없으면 자격을 보지 않고 통과시킨다', async () => {
      const response = await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);

      expect(response.body.warnings).toEqual([]);
    });

    it('BLOCK이면 자격 없는 작업자를 막는다', async () => {
      await setPolicy('BLOCK');

      await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(403);

      const sessions = await prisma.work_session.count({
        where: { work_order_id: fixture.workOrderId },
      });
      expect(sessions).toBe(0);
    });

    it('WARN이면 경고를 싣고 시작시킨다', async () => {
      await setPolicy('WARN');

      const response = await startRequest().set(WORKER_NO_HEADER, WORKER_NO).send({}).expect(201);

      expect(response.body.warnings).toHaveLength(1);
      expect(response.body.warnings[0]).toContain('INJECTION');
    });
  });
});
