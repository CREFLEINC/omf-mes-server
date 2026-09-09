/**
 * int64 범위를 넘는 경로·질의 값이 500 이 아니라 400 이 되는지 본다.
 *
 * ⭐ PR #485(I-16 취급 단위 조회) 리뷰가 취급 단위 3자리에서 찾았지만 **그 PR 만의 결함이
 * 아니다** — 계약이 `format: int64` 를 적은 자리가 1456곳이고, 그중 구현된 오퍼레이션
 * **210건이 400 을 선언하지 않은 채 500 을 내고 있었다**(통보 210). 그래서 취급 단위가
 * 아니라 **공용 자리**(`contract-validator.ts` 의 int64 format)를 검사한다.
 *
 * ⚠ 모듈을 여럿 섞는 이유 — 한 모듈만 보면 「그 컨트롤러가 고쳐졌다」와 「공용 검증기가
 * 고쳐졌다」가 구분되지 않는다. 재고·물류·품질·추적·기준정보·생산·앱 일곱 도메인에서
 * 하나씩 집어, 공용 자리를 되돌리면 일곱이 «함께» 빨개지게 둔다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-int64-range';
const PASSWORD = '정수범위-검사-비밀번호';

/** 1e20 — int64 최대(약 9.22e18) 초과. `Number.isInteger` 는 이것을 참으로 본다. */
const OVER = '99999999999999999999';
/** 배정도가 표현할 수 있는 가장 큰 int64. 유효한 값이라 통과해야 한다. */
const LARGEST_VALID = '9223372036854774784';
/** int64 로는 «유효한» 최솟값이지만 Prisma 가 못 받는다 — 여기서 안 막으면 500 이다. */
const INT64_MIN = '-9223372036854775808';
/** 배정도로 표현 가능한 가장 작은 int64. 유효한 값이라 통과해야 한다. */
const SMALLEST_VALID = '-9223372036854774784';

describe('int64 범위 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '정수범위검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.user_credential.deleteMany({ where: { app_user: { login_id: LOGIN_ID } } });
    await prisma.app_user.deleteMany({ where: { login_id: LOGIN_ID } });
  }

  function get(url: string) {
    return request(app.getHttpServer()).get(url).set('Cookie', cookie);
  }

  /** 일곱 도메인의 경로 파라미터. 계약이 일곱 다 400 을 «선언하지 않았다»(통보 210). */
  const pathCases: [string, string, string][] = [
    ['재고 · 취급 단위', `/api/inventory/handling-units/${OVER}`, 'handlingUnitId'],
    ['재고 · 취급 단위 구성', `/api/inventory/handling-units/${OVER}/contents`, 'handlingUnitId'],
    ['물류 · 입하', `/api/logistics/asns/${OVER}`, 'asnId'],
    ['물류 · 구매 발주', `/api/logistics/purchase-orders/${OVER}`, 'purchaseOrderId'],
    ['품질 · LOT 보류', `/api/quality/lot-holds/${OVER}`, 'lotHoldId'],
    ['추적 · LOT', `/api/trace/lots/${OVER}`, 'lotId'],
    ['기준정보 · 품목', `/api/mdm/items/${OVER}`, 'itemId'],
    ['생산 · 작업 지시', `/api/production/work-orders/${OVER}`, 'workOrderId'],
    ['앱 · 공지', `/api/app/notices/${OVER}`, 'noticeId'],
  ];

  it.each(pathCases)(
    '%s — 경로가 int64 를 넘으면 500 이 아니라 400 이다',
    async (_domain, url, fieldName) => {
      const response = await get(url).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ scope: 'field', field: fieldName, code: 'INVALID' }),
      ]);
    },
  );

  /** 질의 축. 취급 단위 목록은 리뷰가 실제로 짚은 자리다(`?warehouseId=`). */
  const queryCases: [string, string, string][] = [
    ['재고 · 취급 단위 목록', `/api/inventory/handling-units?warehouseId=${OVER}`, 'warehouseId'],
    ['재고 · 취급 단위 목록(위치)', `/api/inventory/handling-units?locationId=${OVER}`, 'locationId'],
    ['재고 · 예약', `/api/inventory/reservations?itemId=${OVER}`, 'itemId'],
    ['물류 · 입하 목록', `/api/logistics/asns?supplierId=${OVER}`, 'supplierId'],
  ];

  it.each(queryCases)(
    '%s — 질의가 int64 를 넘으면 500 이 아니라 400 이다',
    async (_domain, url, fieldName) => {
      const response = await get(url).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ scope: 'field', field: fieldName, code: 'INVALID' }),
      ]);
    },
  );

  it('음수 쪽도 막는다 — 경로는 `numeric()` 의 `>= 0` 이 없어 여기서만 걸린다', async () => {
    const response = await get(`/api/inventory/handling-units/-${OVER}`).expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: 'handlingUnitId', code: 'INVALID' }),
    ]);
  });

  /**
   * ⭐ 경계를 «양쪽에서» 집는다. 위만 보면 검사가 `false` 를 늘 돌려주는 구현으로도
   * 전건 초록이라 「범위를 본다」가 반증 불가가 된다.
   */
  it.each([
    ['가장 큰', LARGEST_VALID],
    ['가장 작은', SMALLEST_VALID],
  ])('표현 가능한 %s int64 는 통과한다 — 400 이 아니라 404 다', async (_label, value) => {
    const response = await get(`/api/inventory/handling-units/${value}`).expect(404);
    expect(response.body.errors[0]).toMatchObject({ code: 'NOT_FOUND' });
  });

  /**
   * ⛔ int64 최솟값은 «유효한 int64 인데도» 막는다 — Prisma 가 `|v| >= 2^63` 을
   * ⌜Expected BigInt, provided Float⌝ 로 던져 500 이 되기 때문이다. 하한을 `>=` 로
   * 닫아 두면 배정도로 이 값이 되는 513개가 전부 500 으로 샌다.
   */
  it('int64 최솟값 -(2^63) 은 500 이 아니라 400 이다 — 하한도 «열린» 구간이다', async () => {
    const response = await get(`/api/inventory/handling-units/${INT64_MIN}`).expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'handlingUnitId', code: 'INVALID' }),
    ]);
  });

  it('평범한 id 는 그대로 404 다 · 정상 목록은 200 이다', async () => {
    await get('/api/inventory/handling-units/999999999').expect(404);
    await get('/api/inventory/handling-units?page=2&size=10').expect(200);
  });

  it('문자·소수는 예전 그대로 400 `INVALID` 다 — 이 변경이 기존 400 을 안 건드린다', async () => {
    for (const bad of ['abc', '1.5']) {
      const response = await get(`/api/inventory/handling-units/${bad}`).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: 'handlingUnitId', code: 'INVALID' }),
      ]);
    }
  });

  /**
   * `page` 는 계약이 `format: int64` 를 «안 적어» 위 검사가 지나간다 — 그래서 자리도
   * 판정도 다르다(`pagination.ts` · 400 `RANGE`). 두 자리를 한 검사에 두면 공용
   * 검증기만 되돌려도 이 단언이 남아 초록이 된다.
   */
  it('page 가 안전 정수를 넘기면 400 `RANGE` 다 — int64 format 이 아니라 쪽 계산이 막는다', async () => {
    const response = await get(`/api/inventory/handling-units?page=${OVER}`).expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'page', code: 'RANGE' }),
    ]);
  });

  it('size 는 예전처럼 잘린다 — 거절이 아니다(`MAX_SIZE`)', async () => {
    const response = await get(`/api/inventory/handling-units?size=${OVER}`).expect(200);
    expect(response.body.page.size).toBe(200);
  });
});
