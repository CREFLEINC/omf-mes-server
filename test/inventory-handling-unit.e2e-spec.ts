/**
 * 취급 단위 조회 4건(I-16 PR ①②) + 등록(PR ③) + 구성 치환(PR ④). 포장 확정은 PR ⑤
 * 몫이다(`docs/coverage-100/slices/I-16-a2.md` §11-3).
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
const T_MIX = new Date('2026-09-02T12:00:00.000Z');
const T_NEW = new Date('2026-09-03T00:00:00.000Z');
const PASSWORD = '취급단위-검사-비밀번호';
const PREFIX = 'HUE2E';
// ⛔ 사슬 픽스처는 `PREFIX` 를 «안» 쓴다 — 목록 e2e 1 이 `PREFIX` 로 자기 3건을 세므로
//   같은 접두어를 쓰면 그 배열 통째 단언이 깨진다. 정리는 아래 `OURS` 가 둘 다 집는다.
const CHAIN_PREFIX = 'HUCHAIN';
// ⛔ 치환 픽스처도 `PREFIX` 를 안 쓴다 — 같은 이유다. 정리는 `OURS` 의 `created_by` 축이
//   집는다(아래 `makeUnit` 이 우리 계정을 심는다).
const PUT_PREFIX = 'HUPUT';
const PATH = '/api/inventory/handling-units';
const ROLE = 'E2E_HU';
// `POST /inventory/handling-units` 의 도출 권한 셋 중 하나(`derived-permissions.ts:165`).
const PERMISSIONS = ['M-04-03'];
const WORKER_NO = 'HUE2E01';
/**
 * 이 스위트가 만든 취급 단위 — 채번된 `HU-…` 도 잡아야 창고·위치 삭제가 안 막힌다(S-12).
 * ⭐ 이름·작성자뿐 아니라 «우리 창고·위치를 가리키는가»도 본다 — `created_by` 가 어긋난
 * 행이 하나만 남아도 창고 삭제가 FK 로 막혀 다음 실행이 통째로 붉어진다(변이 주입 중 실측).
 */
const OURS =
  `(handling_unit_no LIKE '${PREFIX}%' OR handling_unit_no LIKE '${CHAIN_PREFIX}%'` +
  ` OR handling_unit_no LIKE '${PUT_PREFIX}%'` +
  ` OR created_by IN (SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${LOGIN_LIKE}')` +
  ` OR warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')` +
  ` OR location_id IN (SELECT location_id FROM mdm.location WHERE location_code LIKE '${PREFIX}%'))`;

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
interface ColumnShape {
  column_name: string;
  domain_name: string | null;
  is_nullable: string;
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

describe('취급 단위 조회·등록 (e2e)', () => {
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
  // ⭐ 계약의 `MERGE` 는 원본이 여럿이라 라인이 «두 HU 에 걸친다». 그 모양이 픽스처에
  //   없으면 `some` 을 `every` 로 바꿔도 언제나 초록이다(A 만의 이벤트·B 만의 이벤트는
  //   두 연산자가 같은 답을 낸다).
  let eventMixed: number;

  // ⭐ PR ③ 순환 검사용. 물리 CHECK 는 `parent <> self` 하나뿐이라 prisma 로 «이미 순환인»
  //   사슬을 심을 수 있다. 깊이 2(X↔Y)와 깊이 3(P→R→Q→P) 둘 다 둔다 — 자기참조만 막는
  //   구현은 둘 다 통과시킨다. 그리고 «순환이 아닌» 3단 사슬(L1→L2→L3)이 반증이다.
  let cycle2Id: number;
  let cycle3Id: number;
  let chainDeepId: number;
  let userId: number;

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
      eventMixed,
      eventTieHigh,
      eventTieLow,
      eventOld,
    ]);
    expect(body.items.map((e) => e.occurredAt)).toEqual([
      T_NEW.toISOString(),
      T_MIX.toISOString(),
      T_TIE.toISOString(),
      T_TIE.toISOString(),
      T_OLD.toISOString(),
    ]);
    // ⭐ 유형 축의 값이 «셋»이다 — 하나면 상수로 실어도 언제나 초록이다.
    expect(body.items.map((e) => e.repackTypeCode)).toEqual([
      'RECONFIGURE',
      'MERGE',
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
    expect(forB.items.map((e) => e.repackEventId)).toEqual([eventForeign, eventMixed]);
    expect(forB.items[0].lines.map((l) => l.handlingUnitId)).toEqual([huB, huB]);

    // ⭐ 두 HU 에 걸친 MERGE 는 «양쪽 다» 잡힌다 — `some` 을 `every` 로 바꾸면 여기서
    //   양쪽 모두 사라진다. 그리고 라인은 «이벤트 전건»이 온다(대상 HU 로 안 거른다) —
    //   계약 라인의 `handlingUnitId` 가 그 축이다.
    expect(forA.items.map((e) => e.repackEventId)).toContain(eventMixed);
    const mixed = forA.items.find((e) => e.repackEventId === eventMixed);
    expect(mixed?.lines.map((l) => l.handlingUnitId)).toEqual([huB, huA]);
  });

  // ⚠ 계획 §9-3 의 13~17 밖이다 — 서비스의 존재 검사(§10-3 ⓐ)가 시험 없이 남으면
  //   그 줄을 지워도 초록이라 한 건 더 둔다(형제 조회 e2e 12 와 같은 모양).
  it('repack-events — 없는 id 는 404 다(계약 미선언 · 서버가 낸다)', async () => {
    await request(app.getHttpServer())
      .get(`${PATH}/999999999/repack-events`)
      .set('Cookie', cookie)
      .expect(404);
  });


  // ── PR ② 마이그레이션 자체를 재는 자리 ────────────────────────────────────
  // 계약 응답으로는 반증할 수 없는 DDL(칸 목록·nullable·도메인·UNIQUE·CHECK·FK·인덱스)을
  // 잰다 — 저장소 선례 `app-printer-schema.e2e-spec.ts` 형. 이것이 없으면 마이그의 절반이
  // 「지워도 초록」이다. forward-only 라 되돌릴 수 없는 자리이므로 값을 못 박아 둔다.

  it('⭐ 신설 두 표의 칸·nullable·도메인이 정본대로다', async () => {
    const header = await columnsOf('handling_unit_repack_event');
    expect(header.map((c) => c.column_name)).toEqual([
      'handling_unit_repack_event_id',
      'repack_type_code',
      'performed_by',
      'occurred_at',
      'created_at',
    ]);
    // ⛔ 헤더에 `handling_unit_id`·`reason_code`·`repack_event_no` 를 «만들지 않았다»
    //   (MERGE 는 원본이 여럿이라 헤더 한 칸이 거짓말이 되고, 나머지는 계약에 원천이 0이다).
    expect(header.every((c) => c.is_nullable === 'NO')).toBe(true);
    expect(header.find((c) => c.column_name === 'repack_type_code')?.domain_name).toBe('code_t');

    const line = await columnsOf('handling_unit_repack_event_line');
    expect(line.map((c) => c.column_name)).toEqual([
      'handling_unit_repack_event_line_id',
      'handling_unit_repack_event_id',
      'line_no',
      'handling_unit_id',
      'role_code',
      'item_id',
      'lot_id',
      'qty_before',
      'qty_after',
      'uom_id_before',
      'uom_id_after',
      'created_at',
    ]);
    // ⭐ R-2 — 계약에 «없는» 두 칸은 nullable 이다(응답이 안 읽고 서버만 채운다).
    //   ⛔ NOT NULL 로 두면 과거 픽스처·수동 삽입이 막힌다.
    expect(line.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name)).toEqual([
      'uom_id_before',
      'uom_id_after',
    ]);
    // ⭐ qty 는 `app.qty_t`(CHECK VALUE >= 0) 다 — 0 이 담겨야 한다(새 줄의 전량·빠진
    //   줄의 후량). handling_unit_content.qty 의 CHECK (qty > 0) 와 «다른» 규칙이 의도다.
    expect(line.filter((c) => c.domain_name === 'qty_t').map((c) => c.column_name)).toEqual([
      'qty_before',
      'qty_after',
    ]);
  });

  it('⭐ 헤더·라인의 FK 6개·UNIQUE·조회 인덱스가 실재한다', async () => {
    const header = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`
      SELECT conname, confdeltype::text FROM pg_constraint
       WHERE conrelid = 'inventory.handling_unit_repack_event'::regclass AND contype = 'f'`;
    expect(header.map((c) => c.conname)).toEqual(['handling_unit_repack_event_performed_by_fkey']);
    expect(header.map((c) => c.confdeltype)).toEqual(['a']);

    const constraints = await prisma.$queryRaw<
      { conname: string; contype: string; confdeltype: string }[]
    >`
      SELECT conname, contype::text, confdeltype::text FROM pg_constraint
       WHERE conrelid = 'inventory.handling_unit_repack_event_line'::regclass
       ORDER BY conname`;
    // ⭐ `uom` 을 «두 번» 가리킨다 — before/after 가 서로 다른 FK 다.
    expect(constraints.filter((c) => c.contype === 'f').map((c) => c.conname)).toEqual([
      'handling_unit_repack_event_li_handling_unit_repack_event_i_fkey',
      'handling_unit_repack_event_line_handling_unit_id_fkey',
      'handling_unit_repack_event_line_item_id_fkey',
      'handling_unit_repack_event_line_lot_id_fkey',
      'handling_unit_repack_event_line_uom_id_after_fkey',
      'handling_unit_repack_event_line_uom_id_before_fkey',
    ]);
    expect(constraints.map((c) => c.conname)).toContain('uq_handling_unit_repack_event_line');
    // ⭐ 삭제 «동작»까지 잰다(PR #499 리뷰 Major-1) — 이름·종류만 재면 `ON DELETE CASCADE`
    //   로 바꿔도 전건 초록이고, 그러면 취급 단위 한 건을 지우는 것만으로 재구성 이력이
    //   조용히 사라진다. `a` = NO ACTION(형제 표 전건과 같다).
    expect(constraints.filter((c) => c.contype === 'f').map((c) => c.confdeltype)).toEqual([
      'a',
      'a',
      'a',
      'a',
      'a',
      'a',
    ]);
    // ⛔ 코드 칸(`repack_type_code`·`role_code`)에 CHECK 를 «걸지 않았다» — mdm.code_group
    //   에 CD-REPACK-TYPE·CD-ROLE 이 0건이고, 값이 늘면 CHECK 가 먼저 막는다. 유일한
    //   CHECK 는 정렬 축(`line_no > 0`)이다.
    expect(constraints.filter((c) => c.contype === 'c').map((c) => c.conname)).toEqual([
      'handling_unit_repack_event_line_line_no_check',
    ]);
    const headerChecks = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'inventory.handling_unit_repack_event'::regclass AND contype = 'c'`;
    expect(headerChecks).toEqual([]);

    // `GET …/repack-events` 의 «유일한» 축이자 커버링 인덱스다(§2-4).
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname='inventory' AND indexname='ix_handling_unit_repack_event_line_hu'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('(handling_unit_id, handling_unit_repack_event_id)');
  });

  it('⛔ occurred_at 에 DEFAULT 가 «없다» — 계약 required 이자 정렬 1차 축이라 서버가 명시로 싣는다', async () => {
    const defaults = await prisma.$queryRaw<{ column_name: string; column_default: string | null }[]>`
      SELECT column_name, column_default FROM information_schema.columns
       WHERE table_schema='inventory' AND table_name='handling_unit_repack_event'
         AND column_name IN ('occurred_at','created_at')
       ORDER BY column_name`;
    expect(defaults).toEqual([
      { column_name: 'created_at', column_default: 'clock_timestamp()' },
      { column_name: 'occurred_at', column_default: null },
    ]);
  });

  it('⭐ 한 이벤트에 같은 line_no 둘은 거부되고, line_no 0 도 거부된다', async () => {
    const duplicate = {
      handling_unit_repack_event_id: BigInt(eventNew),
      line_no: 1, // eventNew 가 이미 쓰고 있는 번호다
      handling_unit_id: BigInt(huA),
      role_code: 'RESULT',
      item_id: BigInt(item1Id),
      lot_id: BigInt(lot1Id),
      qty_before: 1,
      qty_after: 1,
    };
    await expect(prisma.handling_unit_repack_event_line.create({ data: duplicate })).rejects.toThrow(
      /Unique constraint failed/,
    );
    await expect(
      prisma.handling_unit_repack_event_line.create({ data: { ...duplicate, line_no: 0 } }),
    ).rejects.toThrow(/handling_unit_repack_event_line_line_no_check/);
  });

  // ── PR ③ 등록 (18~24) ────────────────────────────────────────────────────

  it('⭐ 201 — handlingUnitNo 가 HU-{오늘 UTC}- 로 시작하고 statusCode 가 OPEN 이며 ETag 가 1 이다', async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    // ⭐ 축의 값을 «둘» 쏜다 — 유형·창고·위치·부모가 한 값이면 상수로 채워도 초록이다.
    const withPlace = await create({
      handlingUnitTypeCode: 'PALLET',
      warehouseId: warehouse1Id,
      locationId: location1Id,
      parentHandlingUnitId: huA,
    }).expect(201);
    const bare = await create({ handlingUnitTypeCode: 'CART' }).expect(201);

    const validate = validator('POST /inventory/handling-units', 201);
    expect(validate(withPlace.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    expect(withPlace.body.handlingUnit.handlingUnitNo).toMatch(
      new RegExp(`^HU-${day}-\\d{4,}$`),
    );
    expect(withPlace.headers.etag).toBe('1');
    expect(bare.headers.etag).toBe('1');

    // ⭐ 「호출했다」가 아니라 «무엇이 저장됐나»를 잰다 — 응답이 아니라 DB 를 되읽는다.
    const stored = await prisma.handling_unit.findMany({
      where: {
        handling_unit_id: {
          in: [withPlace.body.handlingUnit.handlingUnitId, bare.body.handlingUnit.handlingUnitId],
        },
      },
      orderBy: { handling_unit_id: 'asc' },
    });
    expect(
      stored.map((row) => [
        row.handling_unit_type_code,
        row.status_code,
        nullableId(row.warehouse_id),
        nullableId(row.location_id),
        nullableId(row.parent_handling_unit_id),
        row.version_no,
        nullableId(row.created_by),
        nullableId(row.updated_by),
      ]),
    ).toEqual([
      ['PALLET', 'OPEN', warehouse1Id, location1Id, huA, 1, userId, userId],
      // ⭐ 창고·위치를 «안 보내면 널»이다 — 서버가 기본값을 도출하지 않는다(§4-4).
      //   그리고 이 행이 warehouseId↔locationId 뒤바꿈을 확정으로 잡는다(둘 다 널).
      ['CART', 'OPEN', null, null, null, 1, userId, userId],
    ]);
    expect(stored.every((row) => row.handling_unit_no.startsWith(`HU-${day}-`))).toBe(true);

    // ⭐ ajv 는 여분 칸을 못 잡는다 — 키 집합을 명시로 잰다. ⛔ 특히 PR ② 가 만든
    //   `uomIdBefore`·`uomIdAfter` 나 `versionNo` 가 여기로 새면 안 된다.
    expect(Object.keys(withPlace.body).sort()).toEqual(['contents', 'handlingUnit']);
    expect(Object.keys(withPlace.body.handlingUnit).sort()).toEqual([
      'handlingUnitId',
      'handlingUnitNo',
      'handlingUnitTypeCode',
      'locationId',
      'parentHandlingUnitId',
      'statusCode',
      'warehouseId',
    ]);
    expect(withPlace.body.handlingUnit).toMatchObject({
      handlingUnitTypeCode: 'PALLET',
      statusCode: 'OPEN',
      warehouseId: warehouse1Id,
      locationId: location1Id,
      parentHandlingUnitId: huA,
    });
    expect(bare.body.contents).toEqual([]);
  });

  it('contents 를 함께 주면 같은 응답에 그 2행이 실린다', async () => {
    const response = await create({
      handlingUnitTypeCode: 'BOX',
      contents: [
        { itemId: item1Id, lotId: lot1Id, qty: 100, uomId },
        // ⭐ 축을 둘로 벌린다 — 수량·품목·LOT·단위가 한 값이면 매핑을 뒤바꿔도 초록이다.
        //   `100.000001` 은 Decimal(20,6) 의 끝자리다(§9-2).
        { itemId: item2Id, lotId: lot2Id, qty: 100.000001, uomId: uom2Id },
      ],
    }).expect(201);

    const created = response.body.handlingUnit.handlingUnitId as number;
    expect(response.body.contents).toEqual([
      expect.objectContaining({
        handlingUnitId: created,
        itemId: item1Id,
        lotId: lot1Id,
        qty: 100,
        uomId,
      }),
      expect.objectContaining({
        handlingUnitId: created,
        itemId: item2Id,
        lotId: lot2Id,
        qty: 100.000001,
        uomId: uom2Id,
      }),
    ]);
    expect(Object.keys(response.body.contents[0]).sort()).toEqual([
      'handlingUnitContentId',
      'handlingUnitId',
      'itemId',
      'lotId',
      'qty',
      'uomId',
    ]);

    // ⭐ DB 로 되읽어 «무엇이 저장됐나»를 확정한다 — 응답 조립만 맞고 저장이 틀릴 수 있다.
    const stored = await prisma.handling_unit_content.findMany({
      where: { handling_unit_id: created },
      orderBy: { handling_unit_content_id: 'asc' },
    });
    expect(
      stored.map((row) => [
        Number(row.item_id),
        Number(row.lot_id),
        row.qty.toString(),
        Number(row.uom_id),
        nullableId(row.created_by),
      ]),
    ).toEqual([
      [item1Id, lot1Id, '100', uomId, userId],
      [item2Id, lot2Id, '100.000001', uom2Id, userId],
    ]);
  });

  it('handlingUnitTypeCode 가 코드 목록에 없으면 400 INVALID 다', async () => {
    const response = await create({ handlingUnitTypeCode: 'NO_SUCH_TYPE' }).expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({
        scope: 'field',
        field: 'handlingUnitTypeCode',
        code: 'INVALID',
      }),
    ]);
    // ⭐ 반증 — 시드된 세 값은 통과한다(검증을 「전부 거부」로 바꿔도 초록이 되지 않는다).
    await create({ handlingUnitTypeCode: 'BOX' }).expect(201);
  });

  it('⭐ 부모 사슬이 순환이면 400 INVALID — 깊이 2(A→B→A) 도 깊이 3(A→B→C→A) 도 잡는다', async () => {
    for (const parent of [cycle2Id, cycle3Id]) {
      const response = await create({
        handlingUnitTypeCode: 'PALLET',
        parentHandlingUnitId: parent,
      }).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ scope: 'field', field: 'parentHandlingUnitId', code: 'INVALID' }),
      ]);
    }

    // ⭐⭐ 반증 둘 — 「부모가 부모를 가지면 거부」·「깊이 상한을 둔다」로 구현해도 초록이
    //    되지 않게 한다. 3단 사슬 아래에 4단째를 실제로 «만든다»(계획 §4-3 기준 1).
    const deep = await create({
      handlingUnitTypeCode: 'PALLET',
      parentHandlingUnitId: chainDeepId,
    }).expect(201);
    expect(deep.body.handlingUnit.parentHandlingUnitId).toBe(chainDeepId);

    // ⛔ 없는 부모는 404 가 아니라 400 이다(계약이 404 를 선언하지 않았다 · §4-4).
    const absent = await create({
      handlingUnitTypeCode: 'PALLET',
      parentHandlingUnitId: 999999999,
    }).expect(400);
    expect(absent.body.errors).toEqual([
      expect.objectContaining({ field: 'parentHandlingUnitId', code: 'INVALID' }),
    ]);
  });

  /**
   * ⭐ `assertReferences` 를 «지워도» 초록이면 안 된다(PR #522 리뷰 Major-1).
   * 지우면 물리 FK 가 대신 400 을 내는데(`prisma-error.ts` 가 P2003 을 접는다) 봉투가 다르다:
   *   ⓐ FK 는 **처음 걸린 하나만** 낸다 — 둘이 틀려도 오류 1건이다
   *   ⓑ 중첩 create 의 `modelName` 이 부모라 `contents[i].itemId` 이름을 못 되뽑는다
   * 위의 `parentHandlingUnitId` 하나짜리 시험은 하필 두 경로의 봉투가 «같은» 자리였다.
   */
  it('⭐ 참조 존재 확인 — 창고·위치가 함께 없으면 오류가 «둘»이고, 없는 품목은 contents[i] 로 짚는다', async () => {
    const both = await create({
      handlingUnitTypeCode: 'PALLET',
      warehouseId: 999999999,
      locationId: 999999998,
    }).expect(400);
    // ⛔ FK 그물은 여기서 1건만 낸다 — 「둘」이 `assertReferences` 의 지문이다.
    expect(both.body.errors).toHaveLength(2);
    expect(both.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'locationId',
      'warehouseId',
    ]);

    const line = await create({
      handlingUnitTypeCode: 'BOX',
      contents: [{ itemId: 999999999, lotId: lot1Id, qty: 1, uomId }],
    }).expect(400);
    // ⛔ FK 그물은 이 이름을 못 만든다(중첩 create 의 modelName 이 부모다).
    expect(line.body.errors).toEqual([
      expect.objectContaining({ field: 'contents[0].itemId', code: 'INVALID' }),
    ]);
  });

  it('contents 안 같은 (itemId, lotId) 둘이면 400 UNIQUE_VIOLATION 이다', async () => {
    const response = await create({
      handlingUnitTypeCode: 'BOX',
      contents: [
        { itemId: item1Id, lotId: lot1Id, qty: 1, uomId },
        { itemId: item1Id, lotId: lot1Id, qty: 2, uomId: uom2Id },
      ],
    }).expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'contents[1]', code: 'UNIQUE_VIOLATION' }),
    ]);

    // ⭐ 반증 — 축을 `itemId` «만»으로 좁히면 이 두 줄이 400 이 되어 빨개진다.
    const distinct = await create({
      handlingUnitTypeCode: 'BOX',
      contents: [
        { itemId: item1Id, lotId: lot1Id, qty: 1, uomId },
        { itemId: item1Id, lotId: lot2Id, qty: 2, uomId },
      ],
    }).expect(201);
    expect(distinct.body.contents.map((c: { lotId: number }) => c.lotId)).toEqual([lot1Id, lot2Id]);
  });

  it('X-Worker-No 가 없으면 400 REQUIRED · 없는 사번이면 400 INVALID 다', async () => {
    const before = await prisma.handling_unit.count({ where: { created_by: userId } });

    const missing = await create({ handlingUnitTypeCode: 'BOX' }, { worker: null }).expect(400);
    expect(missing.body.errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'X-Worker-No', code: 'REQUIRED' }),
    ]);

    // ⭐ 존재 조회를 지우면 여기가 초록이 된다(변이 25).
    const unknown = await create({ handlingUnitTypeCode: 'BOX' }, { worker: 'NO-SUCH' }).expect(400);
    expect(unknown.body.errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'X-Worker-No', code: 'INVALID' }),
    ]);

    // ⛔ 둘 다 «아무것도 안 만들고» 끝난다 — 사번 가드가 채번·INSERT 보다 먼저다.
    expect(await prisma.handling_unit.count({ where: { created_by: userId } })).toBe(before);
  });

  it('⭐ 같은 Idempotency-Key 재전송 — HU 가 안 늘고 첫 응답 그대로이며 재전송에도 ETag 가 온다', async () => {
    const key = randomUUID();
    const body = {
      handlingUnitTypeCode: 'PALLET',
      warehouseId: warehouse2Id,
      contents: [{ itemId: item2Id, lotId: lot2Id, qty: 42.5, uomId: uom2Id }],
    };
    const before = await prisma.handling_unit.count({ where: { created_by: userId } });

    const first = await create(body, { key }).expect(201);
    const second = await create(body, { key }).expect(201);

    expect(await prisma.handling_unit.count({ where: { created_by: userId } })).toBe(before + 1);
    expect(second.body).toEqual(first.body);
    // ⭐ `runIdempotent` 는 `setEtag` 를 안 부른다 — 버전을 «캐시 본문»에 안 실으면 재전송
    //   응답의 이 헤더가 express 의 약한 검증자나 `undefined` 가 된다(§4-1 · 변이 12).
    expect(first.headers.etag).toBe('1');
    expect(second.headers.etag).toBe('1');
  });

  // ── PR ④ `PUT …/contents` (25~32) ────────────────────────────────────────

  it('⭐ 빠진 행 삭제 · 남은 행 갱신 · 새 행 추가를 한 요청에서 — version_no 가 1 오르고 status_code 는 그대로다', async () => {
    const hu = await makeUnit('MIX', [
      { itemId: item1Id, lotId: lot1Id, qty: 10, uomId },
      { itemId: item2Id, lotId: lot2Id, qty: 7, uomId: uom2Id },
    ]);

    const response = await putContents(hu, [
      // 남은 행 — 수량과 «단위»가 둘 다 바뀐다.
      { itemId: item1Id, lotId: lot1Id, qty: 4, uomId: uom2Id },
      // 새 행. ⛔ 빠진 행 `(item2, lot2)` 는 요청에 없다 ⇒ 삭제다(공유계약 A-5).
      { itemId: item2Id, lotId: lot1Id, qty: 5, uomId },
    ]).expect(200);

    const validate = validator('PUT /inventory/handling-units/{handlingUnitId}/contents');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(Object.keys(response.body)).toEqual(['items']);
    // ⭐ ajv 도 `toMatchObject` 도 여분 칸을 못 잡는다 — 키 집합을 명시로 잰다.
    //   ⛔ 서버 전용 `uomIdBefore`·`uomIdAfter` 가 여기로 새면 안 된다(통보 165).
    expect(Object.keys(response.body.items[0]).sort()).toEqual([
      'handlingUnitContentId',
      'handlingUnitId',
      'itemId',
      'lotId',
      'qty',
      'uomId',
    ]);

    // ⭐ 「호출했다」가 아니라 «무엇이 저장됐나»를 잰다.
    const stored = await prisma.handling_unit_content.findMany({
      where: { handling_unit_id: hu },
      orderBy: { handling_unit_content_id: 'asc' },
    });
    expect(
      stored.map((row) => [Number(row.item_id), Number(row.lot_id), Number(row.qty), Number(row.uom_id)]),
    ).toEqual([
      [item1Id, lot1Id, 4, uom2Id],
      [item2Id, lot1Id, 5, uomId],
    ]);
    expect(response.body.items.map((c: { qty: number }) => c.qty)).toEqual([4, 5]);

    const header = await prisma.handling_unit.findUniqueOrThrow({ where: { handling_unit_id: hu } });
    // ⛔ `status_code` 는 안 옮긴다 · `version_no` 는 올린다(잠금 단위가 부모라서다 · §5-4).
    expect([header.version_no, header.status_code, nullableId(header.updated_by)]).toEqual([
      2,
      'OPEN',
      userId,
    ]);
  });

  it('⭐⭐ 이벤트가 1건 생기고 라인이 세 갈래 전건이다 — prisma 로 되읽어 uom_id_before·uom_id_after 를 잰다', async () => {
    const hu = await makeUnit('DIFF', [
      // ⭐ 유지될 줄 — 수량은 그대로고 «단위만» 바뀐다(R-2 의 심장 · 통보 165).
      { itemId: item1Id, lotId: lot1Id, qty: 10, uomId },
      // 빠질 줄.
      { itemId: item2Id, lotId: lot2Id, qty: 7, uomId: uom2Id },
    ]);

    await putContents(hu, [
      { itemId: item1Id, lotId: lot1Id, qty: 10, uomId: uom2Id },
      { itemId: item2Id, lotId: lot1Id, qty: 5, uomId },
    ]).expect(200);

    const events = await prisma.handling_unit_repack_event.findMany({
      where: { lines: { some: { handling_unit_id: hu } } },
      include: { lines: { orderBy: { line_no: 'asc' } } },
    });
    expect(events).toHaveLength(1);
    expect([events[0].repack_type_code, nullableId(events[0].performed_by)]).toEqual([
      'RECONFIGURE',
      userId,
    ]);
    // ⭐ 응답으로는 볼 수 없는 두 칸이다 — 되읽어야 「안 채움」(변이 26)과 「전=후로 채움」
    //   (변이 27)이 둘 다 빨개진다. 2행은 `10 → 10` 이라 수량만으로는 「변화 없음」이다.
    expect(
      events[0].lines.map((line) => [
        line.line_no,
        line.role_code,
        Number(line.item_id),
        Number(line.lot_id),
        Number(line.qty_before),
        Number(line.qty_after),
        nullableId(line.uom_id_before),
        nullableId(line.uom_id_after),
      ]),
    ).toEqual([
      [1, 'SOURCE', item2Id, lot2Id, 7, 0, uom2Id, null],
      [2, 'RESULT', item1Id, lot1Id, 10, 10, uomId, uom2Id],
      [3, 'RESULT', item2Id, lot1Id, 0, 5, null, uomId],
    ]);
  });

  it('⭐ line_no 가 1부터이고 SOURCE 가 위다 — GET …/repack-events 응답을 배열 통째로 단언한다', async () => {
    const hu = await makeUnit('ORDER', [
      { itemId: item2Id, lotId: lot2Id, qty: 3, uomId: uom2Id },
      { itemId: item2Id, lotId: lot1Id, qty: 2, uomId },
    ]);

    await putContents(hu, [
      { itemId: item1Id, lotId: lot2Id, qty: 1, uomId },
      { itemId: item2Id, lotId: lot1Id, qty: 9, uomId: uom2Id },
    ]).expect(200);

    const body = await repackEvents(hu);
    expect(body.items).toHaveLength(1);
    // 정렬은 `(role_code DESC, item_id ASC, lot_id ASC)` — 2차·3차 키를 지우면 빨개진다.
    // ⛔ `toEqual` 이라 응답에 서버 전용 두 칸이 새도 잡힌다(ajv 는 못 잡는다).
    expect(body.items[0].lines).toEqual([
      { handlingUnitId: hu, roleCode: 'SOURCE', itemId: item2Id, lotId: lot2Id, qtyBefore: 3, qtyAfter: 0 },
      { handlingUnitId: hu, roleCode: 'RESULT', itemId: item1Id, lotId: lot2Id, qtyBefore: 0, qtyAfter: 1 },
      { handlingUnitId: hu, roleCode: 'RESULT', itemId: item2Id, lotId: lot1Id, qtyBefore: 2, qtyAfter: 9 },
    ]);
    const stored = await prisma.handling_unit_repack_event_line.findMany({
      where: { handling_unit_id: hu },
      orderBy: { line_no: 'asc' },
    });
    expect(stored.map((line) => line.line_no)).toEqual([1, 2, 3]);
  });

  it('⭐ 최초 채움(빈 HU)도 이벤트가 생기고 라인 전건 qtyBefore 가 0 · uom_id_before 가 NULL 이다', async () => {
    const hu = await makeUnit('EMPTY', []);

    await putContents(hu, [
      { itemId: item1Id, lotId: lot1Id, qty: 12, uomId },
      { itemId: item2Id, lotId: lot2Id, qty: 3.5, uomId: uom2Id },
    ]).expect(200);

    const lines = await prisma.handling_unit_repack_event_line.findMany({
      where: { handling_unit_id: hu },
      orderBy: { line_no: 'asc' },
    });
    expect(
      lines.map((line) => [
        line.role_code,
        Number(line.qty_before),
        Number(line.qty_after),
        nullableId(line.uom_id_before),
        nullableId(line.uom_id_after),
      ]),
    ).toEqual([
      ['RESULT', 0, 12, null, uomId],
      ['RESULT', 0, 3.5, null, uom2Id],
    ]);
  });

  it('⭐ 변화 없는 치환도 이벤트가 «한 건 더» 생기고 qtyBefore === qtyAfter 다(통보 144ⓑ)', async () => {
    const hu = await makeUnit('SAME', [{ itemId: item1Id, lotId: lot1Id, qty: 6, uomId }]);
    const same = [{ itemId: item1Id, lotId: lot1Id, qty: 6, uomId }];

    await putContents(hu, same).expect(200);
    await putContents(hu, same).expect(200);

    // ⛔ 「변화가 있을 때만」으로 바꾸면(변이 13) 여기가 0건이 된다.
    const events = await prisma.handling_unit_repack_event.findMany({
      where: { lines: { some: { handling_unit_id: hu } } },
      include: { lines: true },
      orderBy: { handling_unit_repack_event_id: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(
      events.flatMap((event) => event.lines).map((line) => [
        line.role_code,
        Number(line.qty_before),
        Number(line.qty_after),
        nullableId(line.uom_id_before),
        nullableId(line.uom_id_after),
      ]),
    ).toEqual([
      ['RESULT', 6, 6, uomId, uomId],
      ['RESULT', 6, 6, uomId, uomId],
    ]);
    expect((await prisma.handling_unit.findUniqueOrThrow({ where: { handling_unit_id: hu } })).version_no).toBe(3);
  });

  it('⭐ 빈 배열 → 200 · contents 0행 · 라인 전건 SOURCE·qtyAfter 0 · PACKED 인 HU 도 200 이고 상태 그대로다', async () => {
    // 사실상 「해체」다 — 계약 `required:["items"]` 에 `minItems` 가 없어 허용한다(통보 163ⓓ).
    const hu = await makeUnit(
      'PACKED',
      [
        { itemId: item1Id, lotId: lot1Id, qty: 2, uomId },
        { itemId: item2Id, lotId: lot2Id, qty: 4, uomId: uom2Id },
      ],
      'PACKED',
    );

    const response = await putContents(hu, []).expect(200);

    expect(response.body).toEqual({ items: [] });
    expect(await prisma.handling_unit_content.count({ where: { handling_unit_id: hu } })).toBe(0);
    const header = await prisma.handling_unit.findUniqueOrThrow({ where: { handling_unit_id: hu } });
    // ⛔ 치환은 확정도 해제도 아니다 — `PACKED` 를 막지도 옮기지도 않는다(통보 143ⓓ).
    expect([header.status_code, header.version_no]).toEqual(['PACKED', 2]);

    const lines = await prisma.handling_unit_repack_event_line.findMany({
      where: { handling_unit_id: hu },
      orderBy: { line_no: 'asc' },
    });
    expect(
      lines.map((line) => [line.role_code, Number(line.qty_after), nullableId(line.uom_id_after)]),
    ).toEqual([
      ['SOURCE', 0, null],
      ['SOURCE', 0, null],
    ]);
  });

  it('If-Match 를 안 보내면 통과하고 낡은 토큰이면 409 {conflictCause:user} 다', async () => {
    const hu = await makeUnit('ETAG', [{ itemId: item1Id, lotId: lot1Id, qty: 1, uomId }]);
    // ⭐ 토큰은 «부모» 상세 GET 의 ETag 다 — 이 경로의 조회는 ETag 를 안 내린다(B-1-1).
    const detail = await request(app.getHttpServer()).get(`${PATH}/${hu}`).set('Cookie', cookie).expect(200);
    expect(detail.headers.etag).toBe('1');

    await putContents(hu, [{ itemId: item1Id, lotId: lot1Id, qty: 2, uomId }], {
      ifMatch: detail.headers.etag as string,
    }).expect(200);

    // 그 토큰은 이제 낡았다 — 치환이 부모 버전을 올렸다.
    const stale = await putContents(hu, [{ itemId: item1Id, lotId: lot1Id, qty: 3, uomId }], {
      ifMatch: '1',
    }).expect(409);
    expect(stale.body).toEqual({ conflictCause: 'user', message: expect.any(String) });

    // ⭐ 안 보내면 낙관적 잠금 검사를 건너뛴다 — 오프라인 큐가 토큰을 안 싣는다(C-9).
    await putContents(hu, [{ itemId: item1Id, lotId: lot1Id, qty: 4, uomId }]).expect(200);
    const header = await prisma.handling_unit.findUniqueOrThrow({ where: { handling_unit_id: hu } });
    expect(header.version_no).toBe(3);
    const stored = await prisma.handling_unit_content.findMany({ where: { handling_unit_id: hu } });
    expect(stored.map((row) => Number(row.qty))).toEqual([4]);
  });

  it('⛔ 원장이 0건이다 — 전표·라인이 안 늘고 잔액이 안 바뀐다 · 200 응답 etag 가 버전 토큰이 아니다', async () => {
    const hu = await makeUnit('LEDGER', [{ itemId: item1Id, lotId: lot1Id, qty: 1, uomId }]);
    const ledger = async (): Promise<number[]> =>
      Promise.all([
        prisma.inventory_transaction.count(),
        prisma.inventory_transaction_line.count(),
        prisma.inventory_balance.count(),
      ]);
    const before = await ledger();

    const response = await putContents(hu, [
      { itemId: item1Id, lotId: lot1Id, qty: 9, uomId: uom2Id },
    ]).expect(200);

    expect(await ledger()).toEqual(before);
    // ⭐ R-5 — `toBeUndefined()` 도 `!== String(version_no)` 도 변이를 못 잡는다.
    expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
  });

  it('⭐ 400·404 갈래 — 사번 둘 · 요청 안 중복 · 없는 참조 · 없는 HU. 전부 아무것도 안 바꾼다', async () => {
    const hu = await makeUnit('GUARD', [{ itemId: item1Id, lotId: lot1Id, qty: 1, uomId }]);
    const line = { itemId: item1Id, lotId: lot1Id, qty: 2, uomId };

    const missing = await putContents(hu, [line], { worker: null }).expect(400);
    expect(missing.body.errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'X-Worker-No', code: 'REQUIRED' }),
    ]);
    const unknownWorker = await putContents(hu, [line], { worker: 'NO-SUCH' }).expect(400);
    expect(unknownWorker.body.errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'X-Worker-No', code: 'INVALID' }),
    ]);

    const duplicated = await putContents(hu, [line, { ...line, qty: 3 }]).expect(400);
    expect(duplicated.body.errors).toEqual([
      // ⭐ `contents[…]` 가 아니라 «이 오퍼레이션의» 배열 이름을 짚는다.
      expect.objectContaining({ field: 'items[1]', code: 'UNIQUE_VIOLATION' }),
    ]);

    const unknownRefs = await putContents(hu, [
      { itemId: 999999999, lotId: lot1Id, qty: 1, uomId: 999999999 },
    ]).expect(400);
    expect(unknownRefs.body.errors).toEqual([
      expect.objectContaining({ field: 'items[0].itemId', code: 'INVALID' }),
      expect.objectContaining({ field: 'items[0].uomId', code: 'INVALID' }),
    ]);

    // 계약 미선언이나 404 를 낸다(잠글 행이 없다 · §5-6).
    await putContents(999999999, [line]).expect(404);

    // ⭐ 반증 — `itemId` 만 같고 `lotId` 가 다른 두 줄은 통과한다(중복 축이 두 칸이다).
    await putContents(hu, [line, { itemId: item1Id, lotId: lot2Id, qty: 3, uomId }]).expect(200);
    // ⛔ 위 400·404 다섯은 아무것도 안 바꿨다 — 마지막 200 이 남긴 2행 그대로다.
    expect(await prisma.handling_unit_content.count({ where: { handling_unit_id: hu } })).toBe(2);
    expect(await prisma.handling_unit_repack_event.count({ where: { lines: { some: { handling_unit_id: hu } } } })).toBe(1);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function create(
    body: Record<string, unknown>,
    opts: { key?: string; worker?: string | null } = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .post(PATH)
      .set('Cookie', cookie)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.worker !== null) call.set('X-Worker-No', opts.worker ?? WORKER_NO);
    return call.send(body);
  }

  function putContents(
    handlingUnitId: number,
    items: Record<string, unknown>[],
    opts: { key?: string; worker?: string | null; ifMatch?: string } = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .put(`${PATH}/${handlingUnitId}/contents`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.worker !== null) call.set('X-Worker-No', opts.worker ?? WORKER_NO);
    if (opts.ifMatch !== undefined) call.set('If-Match', opts.ifMatch);
    return call.send({ items });
  }

  /**
   * 치환 시험 «전용» 취급 단위. ⭐ 시험마다 새로 만든다 — 조회 픽스처(A·B·C)를 고치면
   * 앞선 12건이 실행 순서에 매달리고, 「남의 행」을 심는 자리도 사라진다.
   * ⚠ `created_by` 를 심어야 `OURS` 가 집어 창고·위치 삭제가 안 막힌다(S-12).
   */
  async function makeUnit(
    suffix: string,
    contents: { itemId: number; lotId: number; qty: number; uomId: number }[],
    statusCode = 'OPEN',
  ): Promise<number> {
    const unit = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PUT_PREFIX}-${suffix}`,
        handling_unit_type_code: 'PALLET',
        status_code: statusCode,
        created_by: userId,
        updated_by: userId,
        handling_unit_content: {
          create: contents.map((line) => ({
            item_id: line.itemId,
            lot_id: line.lotId,
            qty: line.qty,
            uom_id: line.uomId,
            created_by: userId,
          })),
        },
      },
      select: { handling_unit_id: true },
    });
    return Number(unit.handling_unit_id);
  }

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

  function columnsOf(table: string): Promise<ColumnShape[]> {
    return prisma.$queryRaw<ColumnShape[]>`
      SELECT column_name, domain_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'inventory' AND table_name = ${table}
       ORDER BY ordinal_position`;
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
    userId = Number(user.app_user_id);
    // ⭐ 등록(PR ③)은 403 을 «선언한» 자리라 권한이 필요하다 — 조회 4건은 여전히 0줄이다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '취급단위검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
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

    // ⭐ `X-Worker-No` 는 «읽고 버리는» 축이다(담을 칸 0 · §8-3) — 그래도 존재 확인을 하므로
    //   실재하는 사번이 하나 있어야 등록이 통과한다.
    await prisma.worker.create({
      data: {
        worker_no: WORKER_NO,
        worker_name: '취급단위검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });

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

    cycle2Id = await makeCycle(['X', 'Y']);
    cycle3Id = await makeCycle(['P', 'Q', 'R']);
    // ⭐ 반증 — 순환이 «아닌» 3단 사슬. 여기에 붙이는 등록은 201 이어야 한다(깊이 상한 0).
    chainDeepId = await makeChain(['L1', 'L2', 'L3']);

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
    // ⭐ 두 HU 에 걸친 MERGE — A 로 물어도 B 로 물어도 «둘 다» 잡혀야 한다.
    eventMixed = await makeEvent(T_MIX, 'MERGE', user.app_user_id, [
      { line_no: 1, handling_unit_id: b.handling_unit_id, role_code: 'SOURCE', item_id: item1.item_id, lot_id: lot1.lot_id, qty_before: 8, qty_after: 0, uom_id_before: uom.uom_id, uom_id_after: null },
      { line_no: 2, handling_unit_id: a.handling_unit_id, role_code: 'RESULT', item_id: item1.item_id, lot_id: lot1.lot_id, qty_before: 0, qty_after: 8, uom_id_before: null, uom_id_after: uom.uom_id },
    ]);
  }

  /** 위→아래 사슬 하나. 돌려주는 것은 «맨 아래»(가장 깊은) 행의 id 다. */
  async function makeChain(suffixes: string[]): Promise<number> {
    let parent: bigint | null = null;
    for (const suffix of suffixes) {
      const row: { handling_unit_id: bigint } = await prisma.handling_unit.create({
        data: {
          handling_unit_no: `${CHAIN_PREFIX}-${suffix}`,
          handling_unit_type_code: 'PALLET',
          status_code: 'OPEN',
          parent_handling_unit_id: parent,
        },
        select: { handling_unit_id: true },
      });
      parent = row.handling_unit_id;
    }
    return Number(parent);
  }

  /**
   * ⭐ 사슬을 만든 뒤 «맨 위»의 부모를 «맨 아래»로 돌려 순환을 완성한다. 물리 CHECK 는
   * `parent <> self` 하나뿐이라 이 UPDATE 를 막지 않는다(계획 §4-3 · psql 원문).
   * 돌려주는 것은 맨 아래 행 — 등록이 그것을 부모로 지목한다.
   */
  async function makeCycle(suffixes: string[]): Promise<number> {
    const bottom = await makeChain(suffixes);
    await prisma.handling_unit.update({
      where: { handling_unit_no: `${CHAIN_PREFIX}-${suffixes[0]}` },
      data: { parent_handling_unit_id: bottom },
    });
    return bottom;
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
    // ⭐ 자기 행의 부모뿐 아니라 «자기 행을 부모로 가리키는» 남의 행도 푼다 — 안 그러면
    //   그런 행이 하나만 남아도 아래 DELETE 가 FK 로 막혀 다음 실행이 통째로 붉어진다
    //   (변이 주입 중 실측 · 자가 치유).
    await prisma.$executeRawUnsafe(`
      UPDATE inventory.handling_unit SET parent_handling_unit_id = NULL
       WHERE ${OURS}
          OR parent_handling_unit_id IN (SELECT handling_unit_id FROM inventory.handling_unit WHERE ${OURS})`);
    // ⭐ 신설 두 표를 «가장 먼저» 지운다 — 라인이 handling_unit·item·lot·uom·app_user 를
    //   전부 가리켜, 남으면 아래 삭제가 줄줄이 FK 위반으로 막힌다(§9-1 정리 역순).
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_repack_event_line
       WHERE handling_unit_id IN (
         SELECT handling_unit_id FROM inventory.handling_unit WHERE ${OURS}
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_repack_event
       WHERE performed_by IN (SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${LOGIN_LIKE}')`);
    // ⭐ 우리 품목·LOT 을 «가리키는» 구성 행도 함께 지운다 — 남의 HU 에 달려 있어도
    //   그것은 이 스위트가 만든 것이고, 남으면 아래 lot·item 삭제가 FK 로 막힌다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_content
       WHERE handling_unit_id IN (SELECT handling_unit_id FROM inventory.handling_unit WHERE ${OURS})
          OR item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')
          OR lot_id IN (SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.handling_unit WHERE ${OURS}`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
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
      await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
      await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    }
    await prisma.role_permission.deleteMany({ where: { role: { role_code: ROLE } } });
    await prisma.role.deleteMany({ where: { role_code: ROLE } });
  }
});
