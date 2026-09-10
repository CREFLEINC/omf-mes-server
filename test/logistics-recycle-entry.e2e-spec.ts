/**
 * 재생재 등록 — 화면 `M-01-12`. 「새 자재 LOT 을 만들고 그 수량만큼 재고를 늘린다 — 한
 * 트랜잭션이다」(계약).
 *
 * ⭐ 이 스위트가 못 박는 것 여섯 —
 *  ① 판별자가 **자기 값**(`RECYCLE_ENTRY`)이다(질의 213 → ⓐ) · `sourceDocumentId` 는 등록 건 id
 *  ② 등록 한 번이 **등록 건·LOT·보류·원장·잔액**을 함께 만든다
 *  ③ 응답에 «없는» 저장 칸 여섯을 **DB 로 직접** 확인한다
 *  ④ 등록마다 **LOT 행과 잔액 행이 각각 하나씩** 는다(R-5 — 본문에 `lotId` 가 없어 누적이 아니다)
 *  ⑤ `M-01-12` «만» 가진 계정이 201 이다(R-3 — 도출표에는 그 화면이 없다)
 *  ⑥ 혼적 불허 위치에 다른 품목을 넣어도 201 이다(R-9 — 「막지 않는다」가 설계다)
 *
 * ⚠ **조정 e2e 와 «동시» 실행 금지**(R-8) — 정리가 `TRUNCATE … CASCADE` 라 그 표의
 * `inventory_adjustment_line` 까지 비운다. 자기 파일만 돌린다.
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

const LOGIN_ID = 'e2e-rc-probe';
const SCREEN_ID = 'e2e-rc-screen';
const NOPERM_ID = 'e2e-rc-noperm';
const PASSWORD = 'RC-검사-비밀번호';
const PREFIX = 'RCE2E';
const ROLE = 'E2E_RC';
const SCREEN_ROLE = 'E2E_RC_SCREEN';
/** ⭐ 도출표의 값이다(`M-01-01`·`M-01-02`) — `M-01-12` 는 쓰지 않는다. */
const PERMISSIONS = ['M-01-01', 'M-01-02'];
/** ⭐ R-3 — 화면이 실제로 가진 권한 «하나»뿐. 수동표를 안 더하면 이 계정이 403 이다. */
const SCREEN_PERMISSIONS = ['M-01-12'];
const WORKER_NO = 'RC-W-0001';

/** ⭐ 영업일 축 둘 · `occurredAt` 은 **그 날과 다른 날**의 시각이다(두 축을 섞으면 RED). */
const DAY = '2026-08-11';
const AT = '2026-08-11T09:12:00+09:00';
const DAY2 = '2026-08-12';
const AT2 = '2026-08-13T02:00:00.000Z';

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

const key = (): string => randomUUID();

interface RecycleEntryBody {
  recycleEntryId: number;
  lotId: number;
  lotNo: string;
  itemId: number;
  quantity: number;
  uomId?: number;
  warehouseId?: number;
  locationId?: number;
  businessDate?: string;
  occurredAt?: string;
}

interface Draft {
  itemId: number;
  quantity: number;
  warehouseId: number;
  locationId: number;
  businessDate: string;
  occurredAt: string;
  remarks?: string;
}

interface SendOptions {
  idempotencyKey?: string;
  workerNo?: string | null;
  ifMatch?: string;
  cookie?: string[];
}

describe('재생재 등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let screenCookie: string[];
  let noPermCookie: string[];

  let plantId: number;
  let otherPlantId: number;
  /** `RECYCLED` · 기본 단위 EA */
  let itemId: number;
  /** ⭐ `NEW` · 기본 단위 **KG** — `uomId` 를 첫 품목에서 가져오면 RED */
  let otherItemId: number;
  /** ⭐ `mes_category_code` 가 **NULL** — 「구분을 검증하지 않는다」가 공허하지 않다 */
  let plainItemId: number;
  let eaUomId: number;
  let kgUomId: number;
  let warehouseId: number;
  /** ⭐ **다른 공장**(P2)의 창고 — `plantId` 를 상수나 첫 창고로 못 박으면 RED */
  let otherWarehouseId: number;
  let locationId: number;
  /** 혼적 불허 위치(R-9) — 같은 창고다 */
  let mixedBanLocationId: number;
  /** 남의 창고(P2)의 위치 */
  let foreignLocationId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    await makeMasters();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── 성공 경로 ────────────────────────────────────────────────────────────────

  it('⭐ 1. 201 — 응답 required 5칸이 서고 `lotNo` 가 서버가 매긴 형식이다', async () => {
    const body = await create();

    expect(body.recycleEntryId).toBeGreaterThan(0);
    expect(body.lotId).toBeGreaterThan(0);
    // `M` + 공장 6 + YYYYMMDD + 순번 6 + 난수 13 = 34자(C-2 — 서버가 매긴다).
    expect(body.lotNo).toMatch(/^M\d{6}20260811\d{6}[A-Z2-9]{13}$/);
    expect(body.lotNo).toHaveLength(34);
    expect(body.itemId).toBe(itemId);
    expect(body.quantity).toBe(12.5);
    expect(body.businessDate).toBe(DAY);
    expect(body.occurredAt).toBe(new Date(AT).toISOString());
  });

  it('⭐ 2. 201 — 응답에 «없는» 저장 칸 여섯을 DB 로 직접 확인한다', async () => {
    const body = await create({ remarks: '분쇄재 1차' });

    const row = await entry(body.recycleEntryId);
    // ⭐ 채번 기간 축이 **본문 `businessDate`** 다 — 서버 날짜로 바꾸면 RED.
    expect(row.recycle_entry_no).toMatch(/^RC-20260811-\d{4,}$/);
    expect(row.recycle_type_code).toBe('RECYCLED');
    expect(row.status_code).toBe('POSTED');
    expect(row.processed_at?.toISOString()).toBe(new Date(AT).toISOString());
    expect(row.remarks).toBe('분쇄재 1차');
    // ⛔ 가리킬 문서가 없으면 둘을 함께 비운다(A-10) — 한쪽만 채우지 않는다.
    expect(row.source_document_type_code).toBeNull();
    expect(row.source_document_id).toBeNull();
  });

  it('⭐ 3. 201 — 창고·위치와 공장이 저장된다. 공장은 **창고에서** 푼다', async () => {
    const mine = await create();
    const theirs = await create({
      warehouseId: otherWarehouseId,
      locationId: foreignLocationId,
      businessDate: DAY2,
      occurredAt: AT2,
    });

    const [here, there] = [await entry(mine.recycleEntryId), await entry(theirs.recycleEntryId)];
    expect(Number(here.warehouse_id)).toBe(warehouseId);
    expect(Number(here.destination_location_id)).toBe(locationId);
    expect(Number(here.plant_id)).toBe(plantId);
    // ⭐ 다른 공장의 창고로 보내면 공장도 갈린다 — 상수나 첫 창고로 못 박으면 RED.
    expect(Number(there.plant_id)).toBe(otherPlantId);
    expect(there.plant_id).not.toEqual(here.plant_id);
  });

  it('⭐ 4. 201 — `uom_id` 가 **품목의 기본 단위**다(본문으로 받지 않는다)', async () => {
    const ea = await create();
    const kg = await create({ itemId: otherItemId });

    expect(ea.uomId).toBe(eaUomId);
    expect(kg.uomId).toBe(kgUomId);
    expect(Number((await entry(kg.recycleEntryId)).uom_id)).toBe(kgUomId);
  });

  it('⭐ 5. LOT — 원천이 `RECYCLE_ENTRY` 고 `source_id` 가 등록 건 id 다(구분은 검증하지 않는다)', async () => {
    // ⭐ `mes_category_code` 축 셋(`RECYCLED`·`NEW`·NULL) 전부 통과해야 「검증 0」이 참이다.
    for (const each of [itemId, otherItemId, plainItemId]) {
      const body = await create({ itemId: each, quantity: 3 });

      const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: body.lotId } });
      expect(lot.source_type_code).toBe('RECYCLE_ENTRY');
      expect(Number(lot.source_id)).toBe(body.recycleEntryId);
      expect(lot.lot_type_code).toBe('MATERIAL');
      expect(lot.status_code).toBe('INSPECTION_PENDING');
      expect(Number(lot.initial_qty)).toBe(3);
      expect(Number(lot.item_id)).toBe(each);
      expect(Number(lot.uom_id)).toBe(each === otherItemId ? kgUomId : eaUomId);
      expect(Number(lot.plant_id)).toBe(plantId);
    }
  });

  it('⭐ 6. 수입검사 보류가 **한 행** 걸린다 — 코어가 무조건 거는 것을 그대로 받는다', async () => {
    const body = await create();

    const holds = await prisma.lot_hold.findMany({ where: { lot_id: body.lotId } });
    expect(holds).toHaveLength(1);
    expect(holds[0].reason_code).toBe('INCOMING_INSPECTION_WAIT');
    expect(holds[0].target_lot_status_code).toBe('INSPECTION_PENDING');
  });

  it('⭐ 7. `recycle_entry.lot_id` 가 채워진다 — 역방향은 **호출자**가 쓴다(코어 0줄)', async () => {
    const body = await create();

    expect(Number((await entry(body.recycleEntryId)).lot_id)).toBe(body.lotId);
  });

  it('⭐⭐ 8. 원장 헤더 — 판별자가 `RECYCLE_ENTRY` 다(남의 유형 행을 심어도 갈린다)', async () => {
    const body = await create({ businessDate: DAY2, occurredAt: AT2 });
    // ⭐ 판별자 축에 값을 둘 둔다 — **같은 id** 를 가진 «다른 유형»의 원장 행을 일부러 심는다
    //    (선례 `logistics-stock-transfer.e2e-spec.ts:818-833`). 유형을 빌리면 이 둘이 겹친다.
    await plantDecoy(body.recycleEntryId, DAY2);

    const sameId = await prisma.inventory_transaction.findMany({
      where: { source_document_id: body.recycleEntryId },
    });
    expect(sameId).toHaveLength(2);
    const ours = sameId.filter((row) => row.source_document_type_code === 'RECYCLE_ENTRY');
    expect(ours).toHaveLength(1);

    const header = ours[0];
    expect(Number(header.source_document_id)).toBe(body.recycleEntryId);
    expect(header.transaction_type_code).toBe('RECYCLE_ENTRY');
    expect(header.transaction_no).toBe((await entry(body.recycleEntryId)).recycle_entry_no);
    // ⛔ 영업일은 클라이언트가 보낸 값이다(C-8) — 수신 시각으로 다시 잡으면 RED.
    expect(header.business_date.toISOString().slice(0, 10)).toBe(DAY2);
    expect(header.occurred_at.toISOString()).toBe(new Date(AT2).toISOString());
    expect(header.status_code).toBe('POSTED');
    expect(Number(header.plant_id)).toBe(plantId);
    expect(header.idempotency_key).toBe(`RECYCLE_ENTRY:${header.transaction_no}`);
  });

  it('⭐ 9. 원장 라인 한 줄 — `to_*` 만 있고 `from_*` 는 전부 NULL 이다', async () => {
    const body = await create({ quantity: 4.25 });

    const lines = await ledgerLines(body.recycleEntryId);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.from_warehouse_id).toBeNull();
    expect(line.from_location_id).toBeNull();
    expect(line.from_quality_status_code).toBeNull();
    expect(line.from_inventory_status_code).toBeNull();
    expect(Number(line.to_warehouse_id)).toBe(warehouseId);
    expect(Number(line.to_location_id)).toBe(locationId);
    // ⭐ 같은 tx 가 만든 LOT 과 «같은 값»이다 · 재고 축은 독립이라 `AVAILABLE` 이다.
    expect(line.to_quality_status_code).toBe('INSPECTION_PENDING');
    expect(line.to_inventory_status_code).toBe('AVAILABLE');
    expect(line.ownership_type_code).toBe('OWNED');
    expect(Number(line.lot_id)).toBe(body.lotId);
    expect(Number(line.item_id)).toBe(body.itemId);
    expect(Number(line.qty)).toBe(4.25);
    expect(Number(line.uom_id)).toBe(eaUomId);
  });

  // ── 잔액 ────────────────────────────────────────────────────────────────────

  it('⭐ 10. 잔액 한 행이 서고 차원이 원장 라인과 같다 — 소수도 깎이지 않는다', async () => {
    const body = await create({ quantity: 0.1 });

    const balances = await prisma.inventory_balance.findMany({ where: { lot_id: body.lotId } });
    expect(balances).toHaveLength(1);
    expect(Number(balances[0].on_hand_qty)).toBe(0.1);
    expect(Number(balances[0].plant_id)).toBe(plantId);
    expect(Number(balances[0].warehouse_id)).toBe(warehouseId);
    expect(Number(balances[0].location_id)).toBe(locationId);
    expect(Number(balances[0].item_id)).toBe(itemId);
    expect(balances[0].quality_status_code).toBe('INSPECTION_PENDING');
    expect(balances[0].inventory_status_code).toBe('AVAILABLE');
    expect(balances[0].ownership_type_code).toBe('OWNED');
    expect(Number(balances[0].uom_id)).toBe(eaUomId);
  });

  it('⭐ 11. 등록마다 LOT 행과 잔액 행이 **각각 하나씩** 는다(R-5 — 누적이 아니다)', async () => {
    const lotsBefore = await prisma.lot.count({ where: { item_id: itemId } });
    const balancesBefore = await prisma.inventory_balance.count({ where: { item_id: itemId } });

    const first = await create({ quantity: 2 });
    const second = await create({ quantity: 2 });

    // ⛔ 본문에 `lotId` 가 없어 호출마다 «새 LOT» 이고 `uq_inventory_balance_dim` 이 `lot_id`
    //    를 포함한다 ⇒ 같은 자리에 넣어도 잔액이 «합쳐지지» 않는다.
    expect(first.lotId).not.toBe(second.lotId);
    expect(await prisma.lot.count({ where: { item_id: itemId } })).toBe(lotsBefore + 2);
    expect(await prisma.inventory_balance.count({ where: { item_id: itemId } })).toBe(
      balancesBefore + 2,
    );
    for (const lotId of [first.lotId, second.lotId]) {
      const rows = await prisma.inventory_balance.findMany({ where: { lot_id: lotId } });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].on_hand_qty)).toBe(2);
    }
  });

  // ── 멱등 · 경합 ─────────────────────────────────────────────────────────────

  it('⛔ 12. 같은 멱등키 재전송은 본문이 같고 등록 건이 **1행**이다', async () => {
    const draft = body();
    const idempotencyKey = key();

    const first = await send(draft, { idempotencyKey }).expect(201);
    const second = await send(draft, { idempotencyKey }).expect(201);

    expect(second.body).toEqual(first.body);
    const rows = await prisma.recycle_entry.findMany({
      where: { recycle_entry_id: (first.body as RecycleEntryBody).recycleEntryId },
    });
    expect(rows).toHaveLength(1);
  });

  it('⭐ 13. «다른» 멱등키로 같은 본문이면 전표와 원장이 둘 다 둘이다', async () => {
    const draft = body();

    const first = (await send(draft).expect(201)).body as RecycleEntryBody;
    const second = (await send(draft).expect(201)).body as RecycleEntryBody;

    expect(second.recycleEntryId).not.toBe(first.recycleEntryId);
    // 멱등키가 «전표 번호»에서 나오는 결정적 키라 서로 흡수하지 않는다.
    expect(await ledgerLines(first.recycleEntryId)).toHaveLength(1);
    expect(await ledgerLines(second.recycleEntryId)).toHaveLength(1);
  });

  it('⛔ 14. 재전송이 원장·LOT·잔액을 두 번 쌓지 않는다 — 되읽어 센다', async () => {
    const draft = body();
    const idempotencyKey = key();

    const first = (await send(draft, { idempotencyKey }).expect(201)).body as RecycleEntryBody;
    await send(draft, { idempotencyKey }).expect(201);

    const headers = await prisma.inventory_transaction.count({
      where: { source_document_type_code: 'RECYCLE_ENTRY', source_document_id: first.recycleEntryId },
    });
    expect(headers).toBe(1);
    expect(await prisma.lot.count({ where: { source_id: first.recycleEntryId, source_type_code: 'RECYCLE_ENTRY' } })).toBe(1);
    const balances = await prisma.inventory_balance.findMany({ where: { lot_id: first.lotId } });
    expect(balances).toHaveLength(1);
    expect(Number(balances[0].on_hand_qty)).toBe(12.5);
  });

  // ── 400 갈래 ────────────────────────────────────────────────────────────────

  it('⛔ 15. `quantity = 0` 은 400 **RANGE** 다(`INVALID` 가 아니다)', async () => {
    const rejected = await send({ ...body(), quantity: 0 }).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'quantity', code: 'RANGE' });
  });

  it('⛔ 16. `quantity` 가 음수면 400 RANGE 다', async () => {
    const rejected = await send({ ...body(), quantity: -1 }).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'quantity', code: 'RANGE' });
  });

  it('⛔ 17. 없는 `itemId` 는 400 INVALID 다 — 필드 경로가 `itemId` 다', async () => {
    const rejected = await send({ ...body(), itemId: 999999999 }).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'itemId', code: 'INVALID' });
    expect(rejected.body.errors[0].message).toContain('품목');
  });

  it('⛔ 18. 없는 `warehouseId` 는 400 INVALID 다', async () => {
    const rejected = await send({ ...body(), warehouseId: 999999999 }).expect(400);

    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toContain('warehouseId');
    expect(rejected.body.errors[0].code).toBe('INVALID');
  });

  it('⛔ 19. 위치가 **그 창고 소속이 아니면** 400 INVALID 다', async () => {
    const rejected = await send({ ...body(), locationId: foreignLocationId }).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'locationId', code: 'INVALID' });
    expect(rejected.body.errors[0].message).toContain('창고의 위치');
  });

  it('⛔ 20. 사번이 없으면 400 REQUIRED · 없는 사번이면 400 INVALID 다', async () => {
    const missing = await send(body(), { workerNo: null }).expect(400);
    expect(missing.body.errors[0]).toMatchObject({ field: 'X-Worker-No', code: 'REQUIRED' });

    const unknown = await send(body(), { workerNo: 'NO-SUCH-WORKER' }).expect(400);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'X-Worker-No', code: 'INVALID' });
  });

  // ── 헤더 · 권한 ─────────────────────────────────────────────────────────────

  it('⛔ 21. 201 에 **ETag 가 없다** — 계약 201 에 헤더 선언이 0개다', async () => {
    const created = await send(body()).expect(201);

    // express 가 약한 검증자 `W/"…"` 를 붙인다 — 「버전 번호 토큰이 아니다」를 잰다.
    expect(created.headers.etag ?? '').not.toMatch(/^"?\d+"?$/);
  });

  it('⭐ 22. If-Match 를 **보내도** 201 이다(안 받지만 무해하다)', async () => {
    const created = await send(body(), { ifMatch: '"1"' }).expect(201);

    expect((created.body as RecycleEntryBody).recycleEntryId).toBeGreaterThan(0);
  });

  it('⛔ 23. If-Match 형식이 틀리면 가드가 400 INVALID 를 낸다', async () => {
    const rejected = await send(body(), { ifMatch: '"abc"' }).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ scope: 'screen', code: 'INVALID' });
  });

  it('⛔ 24. 권한이 없으면 403 이다', async () => {
    await send(body(), { cookie: noPermCookie }).expect(403);
  });

  // ── R-n 이 더한 둘 ──────────────────────────────────────────────────────────

  it('⭐ 25. `M-01-12` «만» 가진 계정이 201 이다 — R-3(수동표가 없으면 403)', async () => {
    const created = await send(body(), { cookie: screenCookie }).expect(201);

    expect((created.body as RecycleEntryBody).lotNo).toHaveLength(34);
  });

  it('⭐ 26. 혼적 불허 위치에 다른 품목을 넣어도 201 이다 — R-9(막지 않는 것이 설계다)', async () => {
    // 그 위치에 이미 다른 품목·LOT 이 들어 있는 상태를 만든 뒤 두 번째를 넣는다.
    const first = await create({ itemId, locationId: mixedBanLocationId });
    const second = await create({ itemId: otherItemId, locationId: mixedBanLocationId });

    expect(second.recycleEntryId).not.toBe(first.recycleEntryId);
    const banned = await prisma.location.findUniqueOrThrow({
      where: { location_id: mixedBanLocationId },
    });
    expect([banned.allow_mixed_item, banned.allow_mixed_lot]).toEqual([false, false]);
    const parked = await prisma.inventory_balance.findMany({
      where: { location_id: mixedBanLocationId },
    });
    expect(new Set(parked.map((row) => Number(row.item_id))).size).toBe(2);
  });

  // ── 도구 ────────────────────────────────────────────────────────────────────

  function body(): Draft {
    return {
      itemId,
      quantity: 12.5,
      warehouseId,
      locationId,
      businessDate: DAY,
      occurredAt: AT,
    };
  }

  function send(payload: object, options: SendOptions = {}): request.Test {
    const call = request(app.getHttpServer())
      .post('/api/logistics/recycle-entries')
      .set('Cookie', options.cookie ?? cookie)
      .set('Idempotency-Key', options.idempotencyKey ?? key());
    if (options.workerNo !== null) call.set('X-Worker-No', options.workerNo ?? WORKER_NO);
    if (options.ifMatch !== undefined) call.set('If-Match', options.ifMatch);
    return call.send(payload);
  }

  async function create(overrides: Partial<Draft> = {}): Promise<RecycleEntryBody> {
    const created = await send({ ...body(), ...overrides }).expect(201);
    const validate = validator('POST /logistics/recycle-entries', 201);
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return created.body as RecycleEntryBody;
  }

  function entry(recycleEntryId: number) {
    return prisma.recycle_entry.findUniqueOrThrow({
      where: { recycle_entry_id: recycleEntryId },
    });
  }

  async function ledgerLines(recycleEntryId: number) {
    const header = await prisma.inventory_transaction.findFirstOrThrow({
      where: { source_document_type_code: 'RECYCLE_ENTRY', source_document_id: recycleEntryId },
    });
    return prisma.inventory_transaction_line.findMany({
      where: { inventory_transaction_id: header.inventory_transaction_id },
      orderBy: { line_no: 'asc' },
    });
  }

  /** ⭐ 판별자 축에 값을 둘 만드는 «미끼» — 같은 id, 다른 유형의 원장 헤더다. */
  async function plantDecoy(sourceDocumentId: number, businessDate: string): Promise<void> {
    await prisma.inventory_transaction.create({
      data: {
        business_date: new Date(`${businessDate}T00:00:00.000Z`),
        transaction_no: `${PREFIX}-DECOY-${sourceDocumentId}`,
        transaction_type_code: 'INVENTORY_ADJUSTMENT',
        plant_id: plantId,
        occurred_at: new Date(AT2),
        source_document_type_code: 'INVENTORY_ADJUSTMENT',
        source_document_id: sourceDocumentId,
        status_code: 'POSTED',
        idempotency_key: `${PREFIX}-DECOY-${sourceDocumentId}`,
      },
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '재생재검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '재생재검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '재생재검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);
    const other = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P2`,
        plant_name: '재생재검사공장2',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    otherPlantId = Number(other.plant_id);

    await prisma.worker.create({
      data: {
        worker_no: WORKER_NO,
        worker_name: '재생재작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });

    // ⭐ 단위 둘 — `uomId` 를 첫 품목의 것으로 못 박는 변이를 잡는 축이다.
    const ea = await prisma.uom.create({
      data: { uom_code: `${PREFIX}-EA`, uom_name: '재생재EA', decimal_scale: 3 },
    });
    eaUomId = Number(ea.uom_id);
    const kg = await prisma.uom.create({
      data: { uom_code: `${PREFIX}-KG`, uom_name: '재생재KG', decimal_scale: 3 },
    });
    kgUomId = Number(kg.uom_id);

    // ⭐ 품목 셋 — 구분 축(`RECYCLED`·`NEW`·NULL) × 기본 단위 축(EA·KG).
    const recycled = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '재생재품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: ea.uom_id,
        lot_controlled: true,
        mes_category_code: 'RECYCLED',
      },
    });
    itemId = Number(recycled.item_id);
    const fresh = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT2`,
        item_name: '신재품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: kg.uom_id,
        lot_controlled: true,
        mes_category_code: 'NEW',
      },
    });
    otherItemId = Number(fresh.item_id);
    const plain = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT3`,
        item_name: '구분없음품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: ea.uom_id,
        lot_controlled: true,
      },
    });
    plainItemId = Number(plain.item_id);

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '재생재검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const otherWarehouse = await prisma.warehouse.create({
      data: {
        plant_id: other.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '재생재검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    otherWarehouseId = Number(otherWarehouse.warehouse_id);

    const bin = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC1`,
        location_name: '재생재적치',
        location_type_code: 'BIN',
      },
    });
    locationId = Number(bin.location_id);
    const banned = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC2`,
        location_name: '혼적불허',
        location_type_code: 'BIN',
        allow_mixed_item: false,
        allow_mixed_lot: false,
      },
    });
    mixedBanLocationId = Number(banned.location_id);
    const foreign = await prisma.location.create({
      data: {
        warehouse_id: otherWarehouse.warehouse_id,
        location_code: `${PREFIX}-LOC3`,
        location_name: '남의창고위치',
        location_type_code: 'BIN',
      },
    });
    foreignLocationId = Number(foreign.location_id);

    // ⭐ 표별 id 를 «벌린다» — `recycle_entry` 는 행 0 으로 시작해 첫 id 가 1 이고, 그러면
    //    `recycleEntryId`·`lotId`·`itemId` 를 뒤바꾼 변이가 초록으로 지나간다(R-7 ⓑ).
    await prisma.$executeRawUnsafe(
      `SELECT setval('logistics.recycle_entry_recycle_entry_id_seq', GREATEST(90000, (SELECT last_value FROM logistics.recycle_entry_recycle_entry_id_seq)), true)`,
    );
  }

  async function makeUsers(): Promise<void> {
    noPermCookie = await makeUser(NOPERM_ID, '권한없음', null, []);
    screenCookie = await makeUser(SCREEN_ID, '현장화면', SCREEN_ROLE, SCREEN_PERMISSIONS);
    cookie = await makeUser(LOGIN_ID, '재생재검사', ROLE, PERMISSIONS);
  }

  async function makeUser(
    loginId: string,
    name: string,
    roleCode: string | null,
    permissions: string[],
  ): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: name, status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    if (roleCode !== null) {
      const role = await prisma.role.create({ data: { role_code: roleCode, role_name: name } });
      await prisma.role_permission.createMany({
        data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })),
      });
      await prisma.user_role.create({
        data: { app_user_id: user.app_user_id, role_id: role.role_id },
      });
    }
    return login(loginId);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /**
   * ⚠ **R-8** — 원장 header·line 은 `block_ledger_header_mutation`(TRG-05)이 DELETE 를 막아
   * `TRUNCATE … CASCADE` 뿐이다. 그 CASCADE 가 `inventory_adjustment_line` 까지 비우므로
   * ⛔ 조정 e2e 와 «동시» 실행 금지다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    const byItem = `item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`;
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.inventory_balance WHERE ${byItem}`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.recycle_entry WHERE ${byItem}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_hold
       WHERE lot_id IN (SELECT lot_id FROM trace.lot WHERE ${byItem})`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE ${byItem}`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.uom WHERE uom_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no = '${WORKER_NO}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    for (const id of [LOGIN_ID, SCREEN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    for (const roleCode of [ROLE, SCREEN_ROLE]) {
      const role = await prisma.role.findUnique({ where: { role_code: roleCode } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
