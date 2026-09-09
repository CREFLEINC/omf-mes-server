/**
 * 취급 단위 조회 4건(I-16 PR ①②) — 목록·상세·구성 목록·재구성 이력. 등록·구성 치환·
 * 포장 확정은 뒤 PR 몫이다(`docs/coverage-100/slices/I-16-a2.md` §11-3).
 *
 * ⭐ PR ② 는 «자기 마이그를 지나는» e2e 를 갖는다(§11-3) — 신설
 * `inventory.handling_unit_repack_event(+_line)` 에 prisma 직삽으로 픽스처를 심고
 * `GET …/repack-events` 로 되읽는다. 표를 만들었는데 그 PR 이 한 번도 안 지나는 공백을
 * 없앤다(I-13 R-15 의 교훈).
 *
 * ⚠ 저장소 다른 e2e(`logistics-stock-transfer.e2e-spec.ts`)가 `status_code:'ACTIVE'` 인
 * 취급 단위를 남길 수 있다(통보 164 ⓐ · S-11) — 목록 단언은 «자기 픽스처»의 id 로만
 * 걸러서 본다(§9-1).
 */
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

const LOGIN_ID = 'e2e-hu-probe';
const PERFORMER_LOGIN_ID = 'e2e-hu-performer';
const LOGIN_LIKE = 'e2e-hu-%';
// ⭐ 정렬 축의 «동률»을 픽스처로 명시한다 — 안 그러면 2차 키 단언이 죽는다(I-13 실사고).
const T_OLD = new Date('2026-09-01T00:00:00.000Z');
const T_TIE = new Date('2026-09-02T00:00:00.000Z');
const T_NEW = new Date('2026-09-03T00:00:00.000Z');
const PASSWORD = '취급단위-검사-비밀번호';
const PREFIX = 'HUE2E';
const PATH = '/api/inventory/handling-units';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface HandlingUnitBody {
  handlingUnitId: number;
  handlingUnitNo: string;
  handlingUnitTypeCode: string;
  parentHandlingUnitId: number | null;
  warehouseId: number | null;
  locationId: number | null;
  statusCode: string;
}
interface RepackEventLineFixture {
  line_no: number;
  handling_unit_id: bigint;
  role_code: string;
  item_id: bigint;
  lot_id: bigint;
  qty_before: number;
  qty_after: number;
  uom_id_before: bigint | null;
  uom_id_after: bigint | null;
}
interface RepackEventLineBody {
  handlingUnitId: number;
  roleCode: string;
  itemId: number;
  lotId: number;
  qtyBefore: number;
  qtyAfter: number;
}
interface RepackEventBody {
  repackEventId: number;
  repackTypeCode: string;
  performedBy: number;
  occurredAt: string;
  lines: RepackEventLineBody[];
}
interface PagedHandlingUnits {
  items: HandlingUnitBody[];
  page: { page: number; size: number; total: number };
}

describe('취급 단위 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let warehouse1Id: number;
  let warehouse2Id: number;
  let location1Id: number;
  let location2Id: number;
  let uomId: number;
  let uom2Id: number;
  let item1Id: number;
  let item2Id: number;
  let lot1Id: number;
  let lot2Id: number;

  // §9-2 「픽스처 축의 값이 둘 이상인가」— A: 창고1·위치1·PALLET·OPEN·부모없음·⭐구성 1행.
  // B: 창고2·위치2·BOX·OPEN·부모=A·구성 2행. C: 창고·위치 NULL·PALLET·PACKED·부모없음.
  // ⭐ A 도 구성을 갖는다(PR #485 리뷰 Major-1) — B 만 가지면 `where` 를 통째로 빼도
  //    12건이 전부 초록이라 「남의 파렛트 내용물이 섞여 나온다」가 안 잡힌다.
  // ⭐ `uom` 은 «둘»이다(리뷰 Major-2) — 하나면 uomId 단언이 언제나 초록이고,
  //    단위 변경 이력(통보 165 · R-2)의 심장이 PR ④ 에서 반증 불가가 된다.
  let huA: number;
  let huB: number;
  let huC: number;
  let contentB1: number;
  let contentB2: number;
  let contentA1: number;

  // ⭐ 재구성 이벤트(PR ②). 만든 순서 ≠ 기대 순서다 — 그래야 정렬 두 축이 «둘 다» 반증된다.
  //  · `occurred_at` 축을 지우면 id 역순이 되는데 그것이 기대값과 다르다(eventNew 가 id 최소).
  //  · 2차 키를 지우면 동률 두 건이 삽입 순서(Low → High)로 와서 기대값(High → Low)과 다르다.
  let performerId: number;
  let eventNew: number;
  let eventOld: number;
  let eventTieLow: number;
  let eventTieHigh: number;
  let eventForeign: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixture();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('질의 없이 부르면 등록 역순으로 온다(HU 3개) · page 가 {page,size,total} 세 칸이다', async () => {
    const body = await list('');
    expect(Object.keys(body.page).sort()).toEqual(['page', 'size', 'total']);

    const ownIds = body.items
      .filter((hu) => hu.handlingUnitNo.startsWith(PREFIX))
      .map((hu) => hu.handlingUnitId);
    expect(ownIds).toEqual([huC, huB, huA]);
  });

  it('warehouseId 로 거른다 — 다른 창고 행과 창고가 NULL 인 행이 둘 다 안 잡힌다', async () => {
    const body = await list(`warehouseId=${warehouse1Id}`);
    const ids = body.items.map((hu) => hu.handlingUnitId);

    expect(ids).toContain(huA);
    expect(ids).not.toContain(huB);
    expect(ids).not.toContain(huC);
  });

  it('locationId 로 거른다 — 다른 위치 행과 위치가 NULL 인 행이 둘 다 안 잡힌다', async () => {
    const body = await list(`locationId=${location1Id}`);
    const ids = body.items.map((hu) => hu.handlingUnitId);

    expect(ids).toContain(huA);
    expect(ids).not.toContain(huB);
    expect(ids).not.toContain(huC);
  });

  it('handlingUnitTypeCode=PALLET 로 거른다 — BOX 행이 안 잡힌다 · 값 목록에 없는 코드는 빈 목록(400 아님)', async () => {
    const body = await list('handlingUnitTypeCode=PALLET');
    const ids = body.items.map((hu) => hu.handlingUnitId);
    expect(ids).toEqual(expect.arrayContaining([huA, huC]));
    expect(ids).not.toContain(huB);

    const empty = await list('handlingUnitTypeCode=NONEXISTENT_TYPE');
    expect(empty.items).toEqual([]);
  });

  it('statusCode=OPEN 으로 거른다 — PACKED 행이 안 잡힌다', async () => {
    const body = await list('statusCode=OPEN');
    const ids = body.items.map((hu) => hu.handlingUnitId);
    expect(ids).toEqual(expect.arrayContaining([huA, huB]));
    expect(ids).not.toContain(huC);
  });

  it('q 는 번호 부분 일치다 — 안 걸리는 번호의 행이 있는데도 안 잡힌다', async () => {
    const body = await list('q=ALPHA');
    const ids = body.items.map((hu) => hu.handlingUnitId);
    expect(ids).toEqual(expect.arrayContaining([huA, huB]));
    expect(ids).not.toContain(huC);
  });

  it('size=1000 을 넘겨도 page.size 가 200 이고 page=2 가 두 번째 쪽이다', async () => {
    const capped = await list('size=1000');
    expect(capped.page.size).toBe(200);

    // `q=PREFIX` 로 자기 픽스처 3건만 스코프해 등록 역순 [C,B,A] 를 한 쪽씩 확인한다.
    const page1 = await list(`q=${PREFIX}&size=1&page=1`);
    const page2 = await list(`q=${PREFIX}&size=1&page=2`);
    expect(page1.items[0].handlingUnitId).toBe(huC);
    expect(page2.items[0].handlingUnitId).toBe(huB);
  });

  it('상세 200 — handlingUnit 7칸과 contents 6칸을 값으로 단언한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huB}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/handling-units/{handlingUnitId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    // 같은 형끼리 뒤바꾸면 ajv 가 못 잡는다 — 값으로 단언한다
    // (warehouseId↔locationId, handlingUnitId↔parentHandlingUnitId).
    expect(response.body.handlingUnit).toMatchObject({
      handlingUnitId: huB,
      handlingUnitNo: `${PREFIX}-ALPHA-2`,
      handlingUnitTypeCode: 'BOX',
      parentHandlingUnitId: huA,
      warehouseId: warehouse2Id,
      locationId: location2Id,
      statusCode: 'OPEN',
    });
    expect(response.body.contents).toEqual([
      expect.objectContaining({
        handlingUnitContentId: contentB1,
        handlingUnitId: huB,
        itemId: item1Id,
        lotId: lot1Id,
        qty: 12.5,
        uomId,
      }),
      expect.objectContaining({
        handlingUnitContentId: contentB2,
        handlingUnitId: huB,
        itemId: item2Id,
        lotId: lot2Id,
        qty: 7.25,
        uomId: uom2Id, // ⭐ 두 행의 단위가 다르다 — 한 값을 상수로 실어도 초록이 되지 않는다
      }),
    ]);

    // ⭐ ajv 는 여분 칸을 못 잡는다(`additionalProperties` 미선언) — 키 집합을 명시로 잰다
    //   (리뷰 Major-3 · `versionNo`·`createdAt` 이 새도 `toMatchObject` 는 초록이었다).
    expect(Object.keys(response.body).sort()).toEqual(['contents', 'handlingUnit']);
    expect(Object.keys(response.body.handlingUnit).sort()).toEqual([
      'handlingUnitId',
      'handlingUnitNo',
      'handlingUnitTypeCode',
      'locationId',
      'parentHandlingUnitId',
      'statusCode',
      'warehouseId',
    ]);
    expect(Object.keys(response.body.contents[0]).sort()).toEqual([
      'handlingUnitContentId',
      'handlingUnitId',
      'itemId',
      'lotId',
      'qty',
      'uomId',
    ]);

    // ⭐ 남의 구성이 섞여 나오지 않는다 — `contentsOf` 의 `where` 를 빼면 여기가 빨개진다.
    expect(response.body.contents.map((c: { handlingUnitContentId: number }) => c.handlingUnitContentId)).toEqual([
      contentB1,
      contentB2,
    ]);
  });

  it('상세 응답 ETag 헤더가 version_no 문자열과 같다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huA}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.headers.etag).toBe('1');
  });

  it('상세 — 없는 id 는 404 다', async () => {
    await request(app.getHttpServer()).get(`${PATH}/999999999`).set('Cookie', cookie).expect(404);
  });

  it('contents 는 {items[]} 만 오고 etag 헤더가 버전 토큰이 아니다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huB}/contents`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/handling-units/{handlingUnitId}/contents');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(Object.keys(response.body)).toEqual(['items']);

    // ⭐ B 의 두 행만 온다 — A 의 구성(contentA1)이 섞이면 빨개진다(리뷰 Major-1).
    expect(response.body.items.map((c: { handlingUnitContentId: number }) => c.handlingUnitContentId)).toEqual([
      contentB1,
      contentB2,
    ]);
    expect(response.body.items.map((c: { uomId: number }) => c.uomId)).toEqual([uomId, uom2Id]);

    // ⭐ R-5 — express 가 JSON 본문에 약한 검증자(W/"...")를 스스로 단다. `toBeUndefined()`
    //   도 `!== String(version_no)` 로도 재지 않는다(저장소 선례 11건 · 두 경로가 다 version
    //   을 +1 해 그 형은 변이를 못 잡는다).
    expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
  });

  it('⭐ contents — A 를 물으면 A 의 한 행만 온다(반대 방향으로도 걸러진다)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huA}/contents`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.items.map((c: { handlingUnitContentId: number }) => c.handlingUnitContentId)).toEqual([
      contentA1,
    ]);
  });

  it('contents — 없는 id 는 404 다(계약 미선언 · 서버가 낸다)', async () => {
    await request(app.getHttpServer()).get(`${PATH}/999999999/contents`).set('Cookie', cookie).expect(404);
  });


  // ── PR ② 재구성 이력 조회 (13~17) ────────────────────────────────────────

  it('이벤트가 0건인 HU 의 repack-events 는 빈 목록이다', async () => {
    const body = await repackEvents(huC);
    expect(Object.keys(body)).toEqual(['items']);
    expect(body.items).toEqual([]);
  });

  it('occurred_at 최신이 위다 · 각 이벤트의 lines 가 line_no asc 다(배열 통째 단언)', async () => {
    const body = await repackEvents(huA);

    expect(body.items.map((e) => e.repackEventId)).toEqual([
      eventNew,
      eventTieHigh,
      eventTieLow,
      eventOld,
    ]);
    expect(body.items.map((e) => e.occurredAt)).toEqual([
      T_NEW.toISOString(),
      T_TIE.toISOString(),
      T_TIE.toISOString(),
      T_OLD.toISOString(),
    ]);
    // ⭐ 유형 축의 값이 둘 이상이다 — 하나면 상수로 실어도 언제나 초록이다.
    expect(body.items.map((e) => e.repackTypeCode)).toEqual([
      'RECONFIGURE',
      'RECONFIGURE',
      'SPLIT',
      'SPLIT',
    ]);

    // 라인은 «만든 순서»가 line_no 역순이라(3→2→1) orderBy 를 빼면 여기가 빨개진다.
    // `line_no` 자체는 계약에 없으니 그것을 따라가는 값으로 잰다.
    expect(body.items[0].lines.map((l) => l.qtyAfter)).toEqual([0, 100.000001, 12.5]);
    expect(body.items[0].lines.map((l) => l.roleCode)).toEqual(['SOURCE', 'RESULT', 'RESULT']);
  });

  it('⭐ occurred_at 이 동률인 두 건은 repackEventId 역순이다(2차 키 반증)', async () => {
    expect(eventTieHigh).toBeGreaterThan(eventTieLow); // 「동률 픽스처」가 실제로 동률인지
    const body = await repackEvents(huA);

    const tied = body.items.filter((e) => e.occurredAt === T_TIE.toISOString());
    expect(tied.map((e) => e.repackEventId)).toEqual([eventTieHigh, eventTieLow]);
  });

  it('⭐ 헤더 5칸·라인 6칸 전건 값 단언 — uomId·uomIdBefore·uomIdAfter 가 응답에 없다', async () => {
    const body = await repackEvents(huA);
    const event = body.items[0];

    // 같은 형끼리 뒤바꾸면 ajv 가 못 잡는다(qtyBefore↔qtyAfter · itemId↔lotId) — 값으로 잰다.
    expect(event).toEqual({
      repackEventId: eventNew,
      repackTypeCode: 'RECONFIGURE',
      performedBy: performerId,
      occurredAt: T_NEW.toISOString(),
      lines: [
        { handlingUnitId: huA, roleCode: 'SOURCE', itemId: item1Id, lotId: lot1Id, qtyBefore: 100, qtyAfter: 0 },
        { handlingUnitId: huA, roleCode: 'RESULT', itemId: item1Id, lotId: lot1Id, qtyBefore: 0, qtyAfter: 100.000001 },
        { handlingUnitId: huA, roleCode: 'RESULT', itemId: item2Id, lotId: lot2Id, qtyBefore: 12.5, qtyAfter: 12.5 },
      ],
    });

    // ⭐ ajv 도 `toMatchObject` 도 여분 칸을 못 잡는다 — 키 집합을 «명시로» 잰다.
    //   `toEqual` 은 `undefined` 로 실린 칸을 통과시키므로 이 단언이 겹으로 필요하다.
    expect(Object.keys(event).sort()).toEqual([
      'lines',
      'occurredAt',
      'performedBy',
      'repackEventId',
      'repackTypeCode',
    ]);
    for (const line of body.items.flatMap((e) => e.lines)) {
      expect(Object.keys(line).sort()).toEqual([
        'handlingUnitId',
        'itemId',
        'lotId',
        'qtyAfter',
        'qtyBefore',
        'roleCode',
      ]);
    }

    // ⭐⭐ R-2 — 서버 전용 두 칸은 «DB 에 실제로 채워져 있다». 응답에만 없는 것이지
    //    픽스처가 빈 것이 아니다(빈 픽스처면 「응답에 없다」가 공짜로 초록이 된다).
    //    단위 축도 둘이다: uom → NULL · NULL → uom2 · uom → uom2(단위만 바뀐 줄 · 통보 165).
    const stored = await prisma.handling_unit_repack_event_line.findMany({
      where: { handling_unit_repack_event_id: eventNew },
      orderBy: { line_no: 'asc' },
    });
    expect(stored.map((l) => [nullableId(l.uom_id_before), nullableId(l.uom_id_after)])).toEqual([
      [uomId, null],
      [null, uom2Id],
      [uomId, uom2Id],
    ]);
  });

  it('⭐ 다른 HU 의 라인만 가진 이벤트는 안 잡힌다(라인 축 필터를 양방향으로 잰다)', async () => {
    const forA = await repackEvents(huA);
    expect(forA.items.map((e) => e.repackEventId)).not.toContain(eventForeign);

    // 반대 방향 — B 를 물으면 B 의 이벤트 «만» 온다(A 의 넷이 안 섞인다).
    const forB = await repackEvents(huB);
    expect(forB.items.map((e) => e.repackEventId)).toEqual([eventForeign]);
    expect(forB.items[0].repackTypeCode).toBe('MERGE');
    expect(forB.items[0].lines.map((l) => l.handlingUnitId)).toEqual([huB, huB]);
  });

  // ⚠ 계획 §9-3 의 13~17 밖이다 — 서비스의 존재 검사(§10-3 ⓐ)가 시험 없이 남으면
  //   그 줄을 지워도 초록이라 한 건 더 둔다(형제 조회 e2e 12 와 같은 모양).
  it('repack-events — 없는 id 는 404 다(계약 미선언 · 서버가 낸다)', async () => {
    await request(app.getHttpServer())
      .get(`${PATH}/999999999/repack-events`)
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function list(qs: string): Promise<PagedHandlingUnits> {
    const response = await request(app.getHttpServer())
      .get(qs ? `${PATH}?${qs}` : PATH)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/handling-units');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body as PagedHandlingUnits;
  }

  async function repackEvents(handlingUnitId: number): Promise<{ items: RepackEventBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${handlingUnitId}/repack-events`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/handling-units/{handlingUnitId}/repack-events');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body as { items: RepackEventBody[] };
  }

  function nullableId(value: bigint | null): number | null {
    return value === null ? null : Number(value);
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeFixture(): Promise<void> {
    // ⛔ 조회 3건은 계약이 403 을 선언하지 않는다 — 역할·권한을 하나도 안 준다
    //    (`permission.guard.ts:37-41` · `app-attachment.e2e-spec.ts` 선례).
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '취급단위검사', status_code: 'EMPLOYED' },
    });
    // ⭐ 이벤트를 «수행한» 계정을 로그인 계정과 다르게 둔다 — 한 값이면 performedBy 를
    //    엉뚱한 칸에서 채워도 초록일 수 있다.
    const performer = await prisma.app_user.create({
      data: { login_id: PERFORMER_LOGIN_ID, user_name: '재구성수행자', status_code: 'EMPLOYED' },
    });
    performerId = Number(performer.app_user_id);
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login();

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '취급단위검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '취급단위검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '취급단위검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });

    const warehouse1 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH1`,
        warehouse_name: '취급단위검사창고1',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse1Id = Number(warehouse1.warehouse_id);
    const warehouse2 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '취급단위검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse2Id = Number(warehouse2.warehouse_id);

    const location1 = await prisma.location.create({
      data: {
        warehouse_id: warehouse1.warehouse_id,
        location_code: `${PREFIX}-LOC1`,
        location_name: '취급단위검사위치1',
        location_type_code: 'BIN',
      },
    });
    location1Id = Number(location1.location_id);
    const location2 = await prisma.location.create({
      data: {
        warehouse_id: warehouse2.warehouse_id,
        location_code: `${PREFIX}-LOC2`,
        location_name: '취급단위검사위치2',
        location_type_code: 'BIN',
      },
    });
    location2Id = Number(location2.location_id);

    const uoms = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    expect(uoms).toHaveLength(2); // 축의 값이 하나면 아래 uomId 단언이 언제나 초록이다
    const [uom, uom2] = uoms;
    uomId = Number(uom.uom_id);
    uom2Id = Number(uom2.uom_id);

    const item1 = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT1`,
        item_name: '취급단위검사품목1',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    item1Id = Number(item1.item_id);
    const item2 = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT2`,
        item_name: '취급단위검사품목2',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    item2Id = Number(item2.item_id);

    const lot1 = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT1`,
        item_id: item1.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lot1Id = Number(lot1.lot_id);
    const lot2 = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT2`,
        item_id: item2.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lot2Id = Number(lot2.lot_id);

    const a = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-ALPHA-1`,
        handling_unit_type_code: 'PALLET',
        warehouse_id: warehouse1.warehouse_id,
        location_id: location1.location_id,
        status_code: 'OPEN',
      },
    });
    huA = Number(a.handling_unit_id);

    const b = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-ALPHA-2`,
        handling_unit_type_code: 'BOX',
        warehouse_id: warehouse2.warehouse_id,
        location_id: location2.location_id,
        status_code: 'OPEN',
        parent_handling_unit_id: a.handling_unit_id,
      },
    });
    huB = Number(b.handling_unit_id);

    const c = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-BETA-1`,
        handling_unit_type_code: 'PALLET',
        status_code: 'PACKED',
      },
    });
    huC = Number(c.handling_unit_id);

    const content1 = await prisma.handling_unit_content.create({
      data: {
        handling_unit_id: b.handling_unit_id,
        item_id: item1.item_id,
        lot_id: lot1.lot_id,
        qty: 12.5,
        uom_id: uom.uom_id,
      },
    });
    contentB1 = Number(content1.handling_unit_content_id);
    const content2 = await prisma.handling_unit_content.create({
      data: {
        handling_unit_id: b.handling_unit_id,
        item_id: item2.item_id,
        lot_id: lot2.lot_id,
        qty: 7.25,
        uom_id: uom2.uom_id,
      },
    });
    contentB2 = Number(content2.handling_unit_content_id);

    // ⭐ A 의 구성 — B 조회에 «섞여 나오면» 안 되는 행이다(리뷰 Major-1).
    const contentA = await prisma.handling_unit_content.create({
      data: {
        handling_unit_id: a.handling_unit_id,
        item_id: item1.item_id,
        lot_id: lot1.lot_id,
        qty: 3.5,
        uom_id: uom2.uom_id,
      },
    });
    contentA1 = Number(contentA.handling_unit_content_id);

    // ⭐ PR ② 의 마이그를 «지나는» 픽스처 — prisma 직삽. 만든 순서를 기대 순서와 어긋나게
    //    둔다(eventNew 가 id 최소): `occurred_at` 축을 지우면 id 역순이 되는데 그것이
    //    기대값과 다르다. 동률 두 건은 Low → High 순으로 심어, 2차 키를 지우면 삽입
    //    순서로 와서 기대값(High → Low)과 다르다.
    eventNew = await makeEvent(T_NEW, 'RECONFIGURE', performer.app_user_id, [
      // ⭐ line_no 역순으로 심는다 — `orderBy line_no asc` 를 빼면 순서 단언이 빨개진다.
      { line_no: 3, handling_unit_id: a.handling_unit_id, role_code: 'RESULT', item_id: item2.item_id, lot_id: lot2.lot_id, qty_before: 12.5, qty_after: 12.5, uom_id_before: uom.uom_id, uom_id_after: uom2.uom_id },
      { line_no: 2, handling_unit_id: a.handling_unit_id, role_code: 'RESULT', item_id: item1.item_id, lot_id: lot1.lot_id, qty_before: 0, qty_after: 100.000001, uom_id_before: null, uom_id_after: uom2.uom_id },
      { line_no: 1, handling_unit_id: a.handling_unit_id, role_code: 'SOURCE', item_id: item1.item_id, lot_id: lot1.lot_id, qty_before: 100, qty_after: 0, uom_id_before: uom.uom_id, uom_id_after: null },
    ]);
    eventOld = await makeEvent(T_OLD, 'SPLIT', user.app_user_id, [
      { line_no: 1, handling_unit_id: a.handling_unit_id, role_code: 'RESULT', item_id: item1.item_id, lot_id: lot1.lot_id, qty_before: 5, qty_after: 7, uom_id_before: uom2.uom_id, uom_id_after: uom2.uom_id },
    ]);
    eventTieLow = await makeEvent(T_TIE, 'SPLIT', user.app_user_id, [
      { line_no: 1, handling_unit_id: a.handling_unit_id, role_code: 'SOURCE', item_id: item2.item_id, lot_id: lot2.lot_id, qty_before: 3, qty_after: 1, uom_id_before: uom.uom_id, uom_id_after: uom.uom_id },
    ]);
    eventTieHigh = await makeEvent(T_TIE, 'RECONFIGURE', user.app_user_id, [
      { line_no: 1, handling_unit_id: a.handling_unit_id, role_code: 'RESULT', item_id: item1.item_id, lot_id: lot1.lot_id, qty_before: 1, qty_after: 3, uom_id_before: uom2.uom_id, uom_id_after: uom.uom_id },
    ]);
    // ⭐ 「거를 남의 행」 — 라인이 전부 B 에 걸린 이벤트다. A 를 물을 때 안 잡혀야 한다.
    eventForeign = await makeEvent(T_NEW, 'MERGE', user.app_user_id, [
      { line_no: 1, handling_unit_id: b.handling_unit_id, role_code: 'SOURCE', item_id: item1.item_id, lot_id: lot1.lot_id, qty_before: 20, qty_after: 0, uom_id_before: uom.uom_id, uom_id_after: null },
      { line_no: 2, handling_unit_id: b.handling_unit_id, role_code: 'RESULT', item_id: item2.item_id, lot_id: lot2.lot_id, qty_before: 0, qty_after: 20, uom_id_before: null, uom_id_after: uom2.uom_id },
    ]);
  }

  /**
   * ⭐ 라인을 «한 건씩 차례로» 심는다 — 중첩 create 는 삽입 순서를 약속하지 않아
   * 「`orderBy line_no` 를 빼면 빨개진다」가 우연에 기대게 된다.
   */
  async function makeEvent(
    occurredAt: Date,
    repackTypeCode: string,
    performedBy: bigint,
    lines: RepackEventLineFixture[],
  ): Promise<number> {
    const event = await prisma.handling_unit_repack_event.create({
      data: { repack_type_code: repackTypeCode, performed_by: performedBy, occurred_at: occurredAt },
    });
    for (const line of lines) {
      await prisma.handling_unit_repack_event_line.create({
        data: { handling_unit_repack_event_id: event.handling_unit_repack_event_id, ...line },
      });
    }
    return Number(event.handling_unit_repack_event_id);
  }

  /**
   * ⚠ S-12 — `handling_unit` 이 `WAREHOUSE_REFERRERS`·`LOCATION_REFERRERS` 에 있다. HU 를
   * 먼저 지우지 않으면 창고·위치 삭제가 막혀 다음 실행이 붉어진다. 자기참조(`parent_
   * handling_unit_id`)는 먼저 풀어 둔 뒤 지운다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      UPDATE inventory.handling_unit SET parent_handling_unit_id = NULL
       WHERE handling_unit_no LIKE '${PREFIX}%'`);
    // ⭐ 신설 두 표를 «가장 먼저» 지운다 — 라인이 handling_unit·item·lot·uom·app_user 를
    //   전부 가리켜, 남으면 아래 삭제가 줄줄이 FK 위반으로 막힌다(§9-1 정리 역순).
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_repack_event_line
       WHERE handling_unit_id IN (
         SELECT handling_unit_id FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_repack_event
       WHERE performed_by IN (SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${LOGIN_LIKE}')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_content
       WHERE handling_unit_id IN (
         SELECT handling_unit_id FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'
       )`);
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    // 계정은 «둘»이다 — 로그인용과 이벤트 수행자용(picked by LIKE).
    const targets = await prisma.app_user.findMany({
      where: { login_id: { in: [LOGIN_ID, PERFORMER_LOGIN_ID] } },
      select: { app_user_id: true },
    });
    const userIds = targets.map((t) => t.app_user_id);
    if (userIds.length > 0) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: { in: userIds } } });
      await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    }
  }
});
