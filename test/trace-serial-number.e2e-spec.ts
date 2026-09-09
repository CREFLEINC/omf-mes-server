import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN = randomUUID().slice(0, 8);
const PREFIX = `SNE2E-${RUN}`;
const LOGIN_ID = `sn-e2e-${RUN}`;
const PASSWORD = 'Serial-검사-비밀번호';
const RAW_A = 'fixture-상태-A';
const RAW_B = 'fixture-상태-B';

function responseValidator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const pointer =
    '/paths/~1trace~1serial-numbers/get/responses/200/content/application~1json/schema';
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface SerialBody {
  serialNumberId: number;
  serialNo: string;
  itemId: number;
  lotId: number;
  statusCode: string;
  producedAt?: string;
  versionNo: number;
}

interface ListBody {
  items: SerialBody[];
  page: { page: number; size: number; total: number };
}

describe('제품 개체 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let itemA: bigint;
  let itemB: bigint;
  let lotA: bigint;
  let lotB: bigint;
  let nullId: bigint;
  let fromId: bigint;
  let toId: bigint;
  let carryId: bigint;
  let mixedId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('필터 없는 목록은 저장된 상태 문자열과 계약 required5를 그대로 반환한다', async () => {
    const body = await list();
    const validate = responseValidator();
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(body.items.find((row) => row.serialNumberId === Number(fromId))).toMatchObject({
      serialNo: `${PREFIX}-Alpha`,
      itemId: Number(itemA),
      lotId: Number(lotA),
      statusCode: RAW_A,
      producedAt: '2026-09-07T00:00:00.000Z',
      versionNo: 6,
    });
  });

  it('lotId는 지정 LOT만 고르고 같은 lot_no인 다른 공장은 섞지 않는다', async () => {
    const body = await list(`lotId=${lotA}`);
    expect(body.items.every((row) => row.lotId === Number(lotA))).toBe(true);
    expect(body.items.map((row) => row.serialNumberId)).not.toContain(Number(mixedId));
  });

  it('itemId는 지정 품목만 고른다', async () => {
    const body = await list(`itemId=${itemB}`);
    expect(body.items.map((row) => row.serialNumberId)).toEqual([Number(mixedId)]);
  });

  it('statusCode는 저장 문자열 정확 일치이고 미등록 문자열은 200 빈 목록이다', async () => {
    expect((await list(`statusCode=${encodeURIComponent(RAW_B)}`)).items).toHaveLength(1);
    expect((await list('statusCode=없는상태')).items).toEqual([]);
  });

  it('q는 일련번호 대소문자 무시 부분일치다', async () => {
    const body = await list(`q=${PREFIX.toLowerCase()}-aLP`);
    expect(body.items.map((row) => row.serialNumberId)).toEqual([Number(fromId)]);
  });

  it('producedFrom 포함·producedTo 제외와 NULL 생산시각 제외를 지킨다', async () => {
    const body = await list(
      'producedFrom=2026-09-07T00%3A00%3A00.000001Z&producedTo=2026-09-07T00%3A00%3A01Z',
    );
    expect(body.items.map((row) => row.serialNumberId)).toEqual([Number(fromId)]);
  });

  it('기간 미지정이면 NULL 생산시각이 포함되고 producedAt 키가 생략된다', async () => {
    const row = (await list()).items.find((item) => item.serialNumberId === Number(nullId));
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('producedAt');
  });

  it('전 필터는 AND이며 모순·역전 구간은 200 빈 목록이다', async () => {
    const contradiction = await list(
      `lotId=${lotA}&itemId=${itemB}&statusCode=${RAW_A}&q=Alpha&producedFrom=2026-09-08T00%3A00%3A00Z&producedTo=2026-09-07T00%3A00%3A00Z`,
    );
    expect(contradiction.items).toEqual([]);
    expect(contradiction.page.total).toBe(0);
  });

  it('size 1은 total을 보존하고 serialNumberId ASC로 쪽을 나눈다', async () => {
    const first = await list('page=1&size=1');
    const second = await list('page=2&size=1');
    expect(first.items).toHaveLength(1);
    expect(first.page.total).toBeGreaterThan(first.items.length);
    expect(first.items[0].serialNumberId).toBeLessThan(second.items[0].serialNumberId);
  });

  it('page/size 기본값과 상한200, 빈 페이지 total을 지킨다', async () => {
    expect((await list()).page).toMatchObject({ page: 1, size: 50 });
    const empty = await list('page=999&size=999');
    expect(empty.items).toEqual([]);
    expect(empty.page).toMatchObject({ page: 999, size: 200, total: 5 });
  });

  it('GET은 사번·멱등·If-Match·추가 권한 없이 가능하다', async () => {
    await request(app.getHttpServer()).get('/api/trace/serial-numbers').expect(401);
    await request(app.getHttpServer())
      .get('/api/trace/serial-numbers')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('GET 전후 개체·LOT·발행기록·멱등·원장 수와 LOT 버전은 변하지 않는다', async () => {
    const before = await state();
    await list(`lotId=${lotA}`);
    expect(await state()).toEqual(before);
  });

  it('실제 µs 격자에서 6·7·9·10자리, 0꼬리와 날짜 캐리 경계를 보존한다', async () => {
    for (const [from, to, expected] of [
      ['2026-09-07T00:00:00.000001Z', '2026-09-07T00:00:00.0000011Z', [Number(fromId)]],
      ['2026-09-07T00:00:00.0000001Z', '2026-09-07T00:00:00.0000010Z', []],
      ['2026-09-07T00:00:00.000001000Z', '2026-09-07T00:00:00.000001001Z', [Number(fromId)]],
      ['2026-09-07T00:00:00.0000010000Z', '2026-09-07T00:00:00.0000010001Z', [Number(fromId)]],
      ['2026-12-31T23:59:59.999999Z', '2026-12-31T23:59:59.9999991Z', [Number(carryId)]],
    ] as const) {
      const body = await list(
        `lotId=${lotA}&producedFrom=${encodeURIComponent(from)}&producedTo=${encodeURIComponent(to)}`,
      );
      expect(body.items.map((row) => row.serialNumberId)).toEqual(expected);
      expect(body.page.total).toBe(expected.length);
    }
  });

  it('Ajv 허용 T/t/공백류·Z/z·offset 형식은 실제 HTTP 경로에서도 같다', async () => {
    for (const value of [
      '2026-09-07T00:00:00.0000001Z',
      '2026-09-07t00:00:00.0000001z',
      '2026-09-07 00:00:00.0000001+00',
      '2026-09-07\t00:00:00.0000001+0000',
    ]) {
      const body = await list(
        `lotId=${lotA}&producedFrom=${encodeURIComponent(value)}&producedTo=2026-09-07T00%3A00%3A02Z`,
      );
      const expected = [Number(fromId), Number(toId)].sort((left, right) => left - right);
      expect(body.items.map((row) => row.serialNumberId)).toEqual(expected);
    }
  });

  async function list(query = ''): Promise<ListBody> {
    const suffix = query === '' ? '' : `?${query}`;
    const response = await request(app.getHttpServer())
      .get(`/api/trace/serial-numbers${suffix}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as ListBody;
  }

  async function state(): Promise<object> {
    const [serials, lots, issues, idempotency, ledger, lot] = await Promise.all([
      prisma.serial_number.count(),
      prisma.lot.count(),
      prisma.document_issue_log.count(),
      prisma.idempotency_record.count(),
      prisma.inventory_transaction.count(),
      prisma.lot.findUniqueOrThrow({ where: { lot_id: lotA }, select: { version_no: true } }),
    ]);
    return { serials, lots, issues, idempotency, ledger, lotVersion: lot.version_no };
  }

  async function makeFixtures(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '개체조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const login = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const rawCookie: unknown = login.headers['set-cookie'];
    cookie = Array.isArray(rawCookie) ? (rawCookie as string[]) : [String(rawCookie)];

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '개체조회법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const plants = await Promise.all(
      ['A', 'B'].map((code) =>
        prisma.plant.create({
          data: {
            legal_entity_id: entity.legal_entity_id,
            plant_code: `${PREFIX}-P${code}`,
            plant_name: `개체조회공장${code}`,
            timezone_code: 'Asia/Ho_Chi_Minh',
          },
        }),
      ),
    );
    const uom = await prisma.uom.findFirstOrThrow();
    const items = await Promise.all(
      ['A', 'B'].map((code) =>
        prisma.item.create({
          data: {
            item_code: `${PREFIX}-I${code}`,
            item_name: `개체조회품목${code}`,
            item_type_code: 'FINISHED_GOOD',
            base_uom_id: uom.uom_id,
            lot_controlled: true,
          },
        }),
      ),
    );
    [itemA, itemB] = items.map((item) => item.item_id);
    const lots = await Promise.all([
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-SAME`,
          item_id: itemA,
          lot_type_code: 'PRODUCT',
          plant_id: plants[0].plant_id,
          initial_qty: 4,
          uom_id: uom.uom_id,
          source_type_code: 'WORK_ORDER',
          source_id: 1,
          status_code: 'NORMAL',
        },
      }),
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-SAME`,
          item_id: itemB,
          lot_type_code: 'PRODUCT',
          plant_id: plants[1].plant_id,
          initial_qty: 1,
          uom_id: uom.uom_id,
          source_type_code: 'WORK_ORDER',
          source_id: 2,
          status_code: 'NORMAL',
        },
      }),
    ]);
    [lotA, lotB] = lots.map((lot) => lot.lot_id);
    const rows = await Promise.all([
      prisma.serial_number.create({
        data: { serial_no: `${PREFIX}-Null`, item_id: itemA, lot_id: lotA, status_code: RAW_A },
      }),
      prisma.serial_number.create({
        data: {
          serial_no: `${PREFIX}-Alpha`,
          item_id: itemA,
          lot_id: lotA,
          status_code: RAW_A,
          produced_at: new Date('2026-09-07T00:00:00.000001Z'),
          version_no: 6,
        },
      }),
      prisma.serial_number.create({
        data: {
          serial_no: `${PREFIX}-To`,
          item_id: itemA,
          lot_id: lotA,
          status_code: RAW_A,
          produced_at: new Date('2026-09-07T00:00:01Z'),
        },
      }),
      prisma.serial_number.create({
        data: {
          serial_no: `${PREFIX}-Mixed`,
          item_id: itemB,
          lot_id: lotB,
          status_code: RAW_B,
          produced_at: new Date('2026-09-08T00:00:00Z'),
        },
      }),
      prisma.serial_number.create({
        data: {
          serial_no: `${PREFIX}-Carry`,
          item_id: itemA,
          lot_id: lotA,
          status_code: RAW_A,
          produced_at: new Date('2026-12-31T23:59:59.999Z'),
        },
      }),
    ]);
    [nullId, fromId, toId, mixedId, carryId] = rows.map((row) => row.serial_number_id);
    // JavaScript Date has only millisecond precision; this fixture must exercise PostgreSQL's real µs grid.
    await prisma.$executeRaw`UPDATE trace.serial_number
      SET produced_at = '2026-09-07T00:00:00.000001Z'::timestamptz
      WHERE serial_number_id = ${fromId}`;
    await prisma.$executeRaw`UPDATE trace.serial_number
      SET produced_at = '2026-12-31T23:59:59.999999Z'::timestamptz
      WHERE serial_number_id = ${carryId}`;
  }

  async function cleanup(): Promise<void> {
    await prisma.serial_number.deleteMany({ where: { serial_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({
      where: { plant: { plant_code: { startsWith: PREFIX } } },
    });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user !== null) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
