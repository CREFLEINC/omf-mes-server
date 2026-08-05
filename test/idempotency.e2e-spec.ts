import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { requestFingerprint } from '../src/common/idempotency/fingerprint';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-IDEM';

describe('멱등 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let plantId: bigint;
  let businessUnitId: bigint;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, ['MASTER_LOGISTICS_WRITE']));
    ({ plantId, businessUnitId } = await createOrganization(prisma, PREFIX));
  });

  afterEach(async () => {
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.idempotency_record.deleteMany({});
  });

  afterAll(async () => {
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await app.close();
  });

  function post(key: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/mdm/warehouses')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  /** 부수 작업이 끝날 때까지 짧게 기다린다. */
  async function waitFor(read: () => Promise<number>, timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let value = await read();
    while (value !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      value = await read();
    }

    return value;
  }

  function valid(overrides: Record<string, unknown> = {}) {
    counter += 1;

    return {
      plantId: Number(plantId),
      businessUnitId: Number(businessUnitId),
      warehouseCode: `${PREFIX}-${counter}`,
      warehouseName: '멱등 테스트 창고',
      warehouseTypeCode: 'MATERIAL',
      managementLevelCode: 'WAREHOUSE',
      ...overrides,
    };
  }

  describe('키 검증', () => {
    it('키가 없으면 400 이고 계약 봉투다', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/api/mdm/warehouses')
        .set('Authorization', `Bearer ${token}`)
        .send(valid())
        .expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'Idempotency-Key', code: 'REQUIRED' });
    });

    it('uuid 가 아니면 400 이다', async () => {
      await post('not-a-uuid', valid()).expect(400);
    });

    it('로그인은 키 없이 부를 수 있다 — 계약 밖 엔드포인트다', async () => {
      // 자격증명이 틀려 401 이지만 400(키 없음)이 아니어야 한다.
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ loginId: '없는계정', password: 'x' })
        .expect(401);
    });
  });

  describe('재전송', () => {
    it('같은 키로 두 번 보내면 창고는 하나만 생기고 응답이 같다', async () => {
      const key = randomUUID();
      const body = valid();

      const first = await post(key, body).expect(201);
      const second = await post(key, body).expect(201);

      expect(second.body).toEqual(first.body);

      const rows = await prisma.warehouse.findMany({
        where: { warehouse_code: body.warehouseCode },
      });
      expect(rows).toHaveLength(1);
    });

    it('재전송은 핸들러를 돌리지 않는다', async () => {
      const key = randomUUID();
      const body = valid();
      const first = await post(key, body).expect(201);

      // 만들어진 창고를 지운 뒤 재전송한다. 핸들러가 돌면 다시 생기고,
      // 저장된 응답을 재생하면 생기지 않는다.
      await prisma.warehouse.deleteMany({ where: { warehouse_code: body.warehouseCode } });

      const second = await post(key, body).expect(201);
      expect(second.body).toEqual(first.body);

      const rows = await prisma.warehouse.findMany({
        where: { warehouse_code: body.warehouseCode },
      });
      expect(rows).toHaveLength(0);
    });

    it('같은 키로 다른 요청을 보내면 400 이다 — 키 오용', async () => {
      const key = randomUUID();
      const body = valid();
      await post(key, body).expect(201);

      const { body: rejected } = await post(key, { ...body, warehouseName: '다른 이름' }).expect(
        400,
      );
      expect(rejected.errors[0]).toMatchObject({ field: 'Idempotency-Key', code: 'RANGE' });
    });

    it('다른 키로 같은 내용을 보내면 중복으로 막힌다 — 멱등은 키로 판단한다', async () => {
      const body = valid();
      await post(randomUUID(), body).expect(201);

      const { body: rejected } = await post(randomUUID(), body).expect(400);
      expect(rejected.errors[0].code).toBe('UNIQUE_VIOLATION');
    });

    it('실패 응답(4xx)도 재생한다 — 다시 보내도 결과가 같다', async () => {
      const key = randomUUID();
      const body = valid({ plantId: 999999999 });

      const first = await post(key, body).expect(400);
      const second = await post(key, body).expect(400);

      expect(second.body).toEqual(first.body);
    });
  });

  describe('처리 중·고아 레코드', () => {
    it('처리 중이면 409 다', async () => {
      const key = randomUUID();
      const body = valid();

      // 첫 요청이 아직 처리 중인 상태를 만든다. 지문을 실제와 같게 넣어야
      // 지문 불일치(400)가 아니라 상태(409)로 갈린다.
      await prisma.idempotency_record.create({
        data: {
          idempotency_key: key,
          request_fingerprint: requestFingerprint('POST', '/api/mdm/warehouses', body),
          status: 'IN_PROGRESS',
          expires_at: new Date(Date.now() + 3_600_000),
        },
      });

      const { body: rejected } = await post(key, body).expect(409);
      expect(rejected.errors[0]).toMatchObject({ scope: 'screen', code: 'IN_PROGRESS' });
    });

    it('60초가 지난 IN_PROGRESS 는 죽은 요청으로 보고 이어받는다', async () => {
      const key = randomUUID();
      const body = valid();

      // 첫 요청이 처리 중에 서버가 죽은 상황을 만든다.
      await post(key, body).expect(201);
      await prisma.warehouse.deleteMany({ where: { warehouse_code: body.warehouseCode } });
      await prisma.idempotency_record.update({
        where: { idempotency_key: key },
        data: { status: 'IN_PROGRESS', created_at: new Date(Date.now() - 120_000) },
      });

      // 이어받아 다시 처리한다. 60초 판정이 없으면 24시간 동안 409 다.
      await post(key, body).expect(201);
    });
  });

  describe('정리', () => {
    it('만료된 기록을 쓰기 때마다 조금씩 지운다', async () => {
      await prisma.idempotency_record.create({
        data: {
          idempotency_key: randomUUID(),
          request_fingerprint: 'expired',
          status: 'COMPLETED',
          response_status: 201,
          completed_at: new Date(),
          expires_at: new Date(Date.now() - 1000),
        },
      });

      await post(randomUUID(), valid()).expect(201);

      // 정리는 응답을 붙잡지 않는 부수 작업이라 조금 늦을 수 있다.
      const remaining = await waitFor(() =>
        prisma.idempotency_record.count({ where: { request_fingerprint: 'expired' } }),
      );
      expect(remaining).toBe(0);
    });
  });
});
