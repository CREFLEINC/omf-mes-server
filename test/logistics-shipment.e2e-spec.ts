/**
 * 출하 조회 둘 — 목록 `GET /logistics/shipments` **13축**(PR ②a) · 상세
 * `GET …/{shipmentId}`(PR ②b · 「라인과 LOT 배분을 함께 내린다 — genealogy 종결점이다」).
 * 화면 `W-04-02`·`W-04-04`·`W-04-12`.
 *
 * ⭐ 축마다 값을 둘 이상 세웠다(README §6-3 ⑵) — 상태 3값 · 창고 둘 · 고객 둘 · 출하작업지시 둘 ·
 *   `shipped_at` 값/널 · 긴급 참/거짓 · 배분 LOT 둘 · 피킹 완료/미완 · 선택 칸 값/널.
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`SHE2E`)로만 한다.
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

const LOGIN_ID = 'e2e-shipment-probe';
const PASSWORD = 'SH-출하-비밀번호';
const PREFIX = 'SHE2E';
const BASE = '/api/logistics/shipments';
/** ⭐ 픽스처가 전부 이 창 안에 있고 다른 스위트의 출하는 밖에 있다. */
const WINDOW = { shipDateFrom: '2026-08-20', shipDateTo: '2026-08-22' };

interface ShipmentBody {
  shipmentId: number;
  shipmentNo: string;
  shipmentRequestId: number;
  warehouseId: number;
  statusCode: string;
  expedited: boolean;
  shippedAt: string | null;
  expediteReason: string | null;
  erpDeliveryNo: string | null;
  vehicleNo?: string;
  versionNo?: number;
}
interface AllocationBody {
  shipmentLotAllocationId: number;
  shipmentId: number;
  shipmentLineId: number;
  itemCode: string;
  warehouseId: number;
  lotId: number;
  handlingUnitId: number | null;
  allocatedQty: number;
  packedQty: number;
  oqcPassed: boolean;
}
interface LineBody {
  shipmentLineId: number;
  lineNo: number;
  shipmentRequestLineId: number;
  goodsIssueLineId: number | null;
  allocations: AllocationBody[];
}
interface ShipmentDetailBody extends ShipmentBody {
  lines: LineBody[];
}
interface Paged {
  items: ShipmentBody[];
  page: { page: number; size: number; total: number };
}

function validator(path = '/logistics/shipments'): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8'),
  ) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/get/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('출하 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  const ids: Record<string, bigint> = {};
  const made: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeShipments();
    await makeUser();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function list(query: Record<string, string | number | boolean>): Promise<Paged> {
    const response = await request(app.getHttpServer())
      .get(BASE)
      .query(query)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as Paged;
  }

  /** 접두어로 좁힌다 — 다른 스위트의 출하가 같은 창에 들어와도 단언이 흔들리지 않는다. */
  async function ours(query: Record<string, string | number | boolean> = {}): Promise<ShipmentBody[]> {
    const body = await list({ ...WINDOW, size: 100, ...query });
    return body.items.filter((item) => item.shipmentNo.startsWith(PREFIX));
  }

  it('L-1 기간으로 거른다 — 기간 밖 행이 빠진다', async () => {
    const inside = await ours();
    expect(inside.map((item) => item.shipmentNo)).toContain(`${PREFIX}-A`);
    // `OUT` 은 2026-07-01 이라 창 밖이다.
    expect(inside.map((item) => item.shipmentNo)).not.toContain(`${PREFIX}-OUT`);
    const wider = await ours({ shipDateFrom: '2026-07-01' });
    expect(wider.map((item) => item.shipmentNo)).toContain(`${PREFIX}-OUT`);
  });

  it('L-2 shipDateFrom 이 없으면 400 REQUIRED 다', async () => {
    const response = await request(app.getHttpServer())
      .get(BASE)
      .set('Cookie', cookie)
      .expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: 'shipDateFrom', code: 'REQUIRED' }),
    ]);
  });

  it('L-3 ⭐ 기간은 «공장 로컬» 날짜다 — shipDateTo 는 선택이고, 줄 때 그 날 하루치가 다 걸린다', async () => {
    const open = await ours({ shipDateFrom: '2026-08-20', shipDateTo: undefined as never });
    expect(open.length).toBeGreaterThan(0);
    // ⭐ 픽스처 축 — 이 시험의 뜻은 공장이 UTC 가 «아닌» 데서 선다.
    const warehouse = await prisma.warehouse.findUniqueOrThrow({
      where: { warehouse_id: BigInt(ids.warehouse) },
      select: { plant: { select: { timezone_code: true } } },
    });
    expect(warehouse.plant.timezone_code).toBe('Asia/Ho_Chi_Minh');
    // `B` 는 2026-08-21T23:30Z = 하노이 **22일 06:30** 이다. UTC 자정으로 견주면 21일에 걸리고
    // 22일에서 샌다 — 두 날을 다 본다. `<= to` 로 적어도 22일에서 샌다(자정만 걸린다).
    expect(await ours({ shipDateFrom: '2026-08-21', shipDateTo: '2026-08-21' })).toEqual([]);
    const day22 = await ours({ shipDateFrom: '2026-08-22', shipDateTo: '2026-08-22' });
    expect(day22.map((item) => item.shipmentNo)).toEqual([
      `${PREFIX}-B`,
      `${PREFIX}-C`,
      `${PREFIX}-D`,
      `${PREFIX}-E`,
    ]);
  });

  it('L-4 statusCode 로 거른다 — 세 값 각각', async () => {
    expect((await ours({ statusCode: 'UNCONFIRMED' })).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-A`,
      `${PREFIX}-B`,
      `${PREFIX}-E`,
    ]);
    expect((await ours({ statusCode: 'CONFIRMED' })).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-C`,
    ]);
    expect((await ours({ statusCode: 'CANCELLED' })).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-D`,
    ]);
  });

  it('L-5 ⭐ unconfirmedOnly 와 statusCode 가 함께 오면 «교집합»이다', async () => {
    // 한쪽이 이기게 만들면 화면이 결과를 못 믿는다 — 0건이 정답이다.
    expect(await ours({ statusCode: 'CONFIRMED', unconfirmedOnly: true })).toEqual([]);
    expect((await ours({ unconfirmedOnly: true })).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-A`,
      `${PREFIX}-B`,
      `${PREFIX}-E`,
    ]);
    // `false` 는 절을 «안 건다» — 전건이 돌아온다.
    expect((await ours({ unconfirmedOnly: false })).length).toBeGreaterThan(2);
  });

  it('L-6 warehouseId 로 거른다 — 다른 창고 행이 빠진다', async () => {
    const first = await ours({ warehouseId: Number(ids.warehouse) });
    const second = await ours({ warehouseId: Number(ids.warehouse2) });
    expect(first.map((i) => i.shipmentNo)).not.toContain(`${PREFIX}-C`);
    expect(second.map((i) => i.shipmentNo)).toEqual([`${PREFIX}-C`]);
    expect(Number(ids.warehouse)).not.toBe(Number(ids.warehouse2));
  });

  it('L-7 customerId 로 거른다 — shipment 에 칸이 없어 출하작업지시를 탄다', async () => {
    const first = await ours({ customerId: Number(ids.customer) });
    const second = await ours({ customerId: Number(ids.customer2) });
    expect(first.map((i) => i.shipmentNo)).toContain(`${PREFIX}-A`);
    expect(first.map((i) => i.shipmentNo)).not.toContain(`${PREFIX}-C`);
    expect(second.map((i) => i.shipmentNo)).toEqual([`${PREFIX}-C`]);
  });

  it('L-8 shipmentRequestId 로 거른다', async () => {
    const rows = await ours({ shipmentRequestId: made.request2 });
    expect(rows.map((i) => i.shipmentNo)).toEqual([`${PREFIX}-C`]);
  });

  it('L-9 ⛔ q 는 shipment_no «만» 본다 — 고객명·LOT 번호로는 0건', async () => {
    expect((await ours({ q: `${PREFIX}-A` })).map((i) => i.shipmentNo)).toEqual([`${PREFIX}-A`]);
    expect(await ours({ q: '출하검사파트너' })).toEqual([]);
    expect(await ours({ q: `${PREFIX}-LOT` })).toEqual([]);
  });

  it('L-10 lotId 로 거른다 — 그 LOT 이 배분된 출하만', async () => {
    expect((await ours({ lotId: Number(ids.lotA) })).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-A`,
    ]);
    expect((await ours({ lotId: Number(ids.lotB) })).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-B`,
    ]);
    // ⭐ `A` 는 배분이 «둘»이다 — 둘째 LOT 으로도 «한 번만» 걸려야 한다(조인이면 두 줄이다).
    expect((await ours({ lotId: Number(ids.lotC) })).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-A`,
    ]);
    expect(Number(ids.lotA)).not.toBe(Number(ids.lotB));
  });

  it('L-11 pickedOnly=true 는 라인 전건이 P=A 인 건만 — 라인 0건은 «빠진다»', async () => {
    const rows = await ours({ pickedOnly: true });
    // `A`·`D` 는 지시 1(예약 합 = 배정 ⇒ 완료) · `B` 는 지시 3(미달) · `C` 는 지시 2(라인 0건).
    // ⛔ `C` 가 «빠지는» 것이 이 시험의 심장이다 — 공허참을 막는 앞 절이 없으면 섞여 든다.
    expect(rows.map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-A`,
      `${PREFIX}-D`,
      `${PREFIX}-E`,
    ]);
    expect(rows.map((i) => i.shipmentNo)).not.toContain(`${PREFIX}-C`);
  });

  it('L-12 ⭐ 기본 정렬은 경과일 긴 순이다 — 배열을 «통째로» 단언한다(중복 0)', async () => {
    // ⛔ `A` 는 배분이 둘이라 `FROM` 을 조인으로 바꾸면 여기서 «두 줄»이 된다(변이 M-10).
    expect((await ours()).map((i) => i.shipmentNo)).toEqual([
      `${PREFIX}-A`,
      `${PREFIX}-B`,
      `${PREFIX}-C`,
      `${PREFIX}-D`,
      `${PREFIX}-E`,
    ]);
  });

  it('L-13 ⭐ shipped_at 이 NULL 인 행은 «목록에 없다» — 기간이 필수라 필연이다', async () => {
    // 3값 논리로 `shipped_at >= from` 이 NULL 행에서 참이 아니다. 정렬 옵션을 바꿔도 마찬가지다
    // ⇒ `NULLS LAST` 는 도달 불가한 절이라 붙이지 않았다(README ⭐ 되풀이 병).
    // ⭐ 우리 API 로 만든 출하는 언제나 값이 있다 — `ShipmentCreate.occurredAt` 이 required 이고
    //   그 값이 이 칸에 든다(§6). 이 갈래는 그 «앞»에 있던 행에만 성립한다 ⇒ 「알려둘 것」.
    const stored = await prisma.shipment.findFirstOrThrow({
      where: { shipment_no: `${PREFIX}-NULLS` },
    });
    expect(stored.shipped_at).toBeNull();
    expect((await ours()).map((i) => i.shipmentNo)).not.toContain(`${PREFIX}-NULLS`);
    expect((await ours({ sort: 'shipmentNo' })).map((i) => i.shipmentNo)).not.toContain(
      `${PREFIX}-NULLS`,
    );
  });

  it('L-14 sort 화이트리스트 밖은 400 INVALID 다', async () => {
    const response = await request(app.getHttpServer())
      .get(BASE)
      .query({ ...WINDOW, sort: 'customerId' })
      .set('Cookie', cookie)
      .expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: 'sort', code: 'INVALID' }),
    ]);
  });

  it('L-15 page·size 와 page 메타 — total 은 쪽이 아니라 «필터 전체» 기준이다', async () => {
    const first = await list({ ...WINDOW, size: 2, page: 1 });
    const beyond = await list({ ...WINDOW, size: 2, page: 99 });
    expect(first.items).toHaveLength(2);
    expect(first.page).toMatchObject({ page: 1, size: 2 });
    expect(first.page.total).toBeGreaterThanOrEqual(4);
    // ⛔ `count(*) OVER ()` 로 세면 범위 밖 쪽에서 total 이 0 으로 접혀 페이저가 사라진다.
    expect(beyond.items).toEqual([]);
    expect(beyond.page.total).toBe(first.page.total);
  });

  it('L-16 ⭐ 목록 응답에 lines 키가 «없다» · 계약 스키마를 만족한다', async () => {
    const body = await list({ ...WINDOW, size: 100 });
    const validate = validator();
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    for (const item of body.items) expect(item).not.toHaveProperty('lines');
  });

  it('L-17 required 여섯 칸과 널 정책 — 긴급 참/거짓 두 갈래', async () => {
    const rows = await ours();
    const a = rows.find((item) => item.shipmentNo === `${PREFIX}-A`);
    const b = rows.find((item) => item.shipmentNo === `${PREFIX}-B`);
    expect(a).toMatchObject({
      shipmentId: made.shipmentA,
      shipmentRequestId: made.request1,
      warehouseId: Number(ids.warehouse),
      statusCode: 'UNCONFIRMED',
      expedited: false,
      vehicleNo: '51C-00001',
    });
    expect(a?.expediteReason).toBeNull();
    expect(a?.erpDeliveryNo).toBeNull();
    // ⭐ 같은 축에 값이 둘이라야 「늘 거짓으로 내린다」 변이가 죽는다.
    expect(b).toMatchObject({ expedited: true, expediteReason: '고객 라인 정지' });
    // 널을 «못 받는» 선택 칸은 키를 생략한다.
    expect(b).not.toHaveProperty('vehicleNo');
    expect(made.shipmentA).not.toBe(made.request1);
  });

  // ── 상세 `GET /logistics/shipments/{shipmentId}` ──────────────────────────
  async function detail(shipmentId: number): Promise<{ body: ShipmentDetailBody; etag?: string }> {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${shipmentId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { body: response.body as ShipmentDetailBody, etag: response.headers.etag };
  }

  it('D-1 라인과 배분을 함께 내린다 — 라인 «둘» · 배분 «셋» · 계약 스키마 통과', async () => {
    const { body } = await detail(made.shipmentA);
    const validate = validator('/logistics/shipments/{shipmentId}');

    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // ⭐ 라인이 둘이고 배분 수가 갈린다(2 · 1) — 「첫 라인만 본다」·「배분을 한 라인에 모은다」가
    //   값에서 드러난다(§6-3 ⑵).
    expect(body.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(body.lines.map((l) => l.allocations.length)).toEqual([2, 1]);
  });

  it('D-2 ⭐ 상세의 ETag 는 version_no «그 값»이다 — 목록의 것은 버전이 아니다', async () => {
    const { etag } = await detail(made.shipmentA);
    const stored = await prisma.shipment.findUniqueOrThrow({
      where: { shipment_id: BigInt(made.shipmentA) },
    });

    // 계약이 ETag 를 «상세에만» 선언했고 :confirm·:cancel 의 If-Match 가 이 값을 담는다.
    expect(etag).toBe(String(stored.version_no));
    expect(etag).toMatch(/^\d+$/);

    // ⚠ Express 가 모든 200 에 «약한 content ETag»(W/"…")를 스스로 단다 — 목록의 헤더는
    //   그것이지 버전이 아니다. 화면이 그것을 If-Match 로 보내면 parseIfMatch 가 숫자가
    //   아니라 거절한다. ⛔ 목록 헤더가 숫자가 되는 순간(우리가 setEtag 를 잘못 달면) 여기서 죽는다.
    const listed = await request(app.getHttpServer())
      .get(BASE)
      .query({ ...WINDOW })
      .set('Cookie', cookie)
      .expect(200);
    expect(listed.headers.etag).not.toMatch(/^\d+$/);
  });

  it('D-3 없는 id 는 404 다', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/999999999`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('D-4 배분의 파생 넷이 실려 온다 — itemCode·warehouseId 는 조인이 만든다', async () => {
    const { body } = await detail(made.shipmentA);
    const first = body.lines[0].allocations[0];

    expect(first).toMatchObject({
      itemCode: `${PREFIX}-IT`,
      warehouseId: Number(ids.warehouse),
      shipmentId: made.shipmentA,
      shipmentLineId: body.lines[0].shipmentLineId,
    });
    // ⛔ `itemCode` 를 품목명에서 길어 오면 여기서 드러난다(코드 ≠ 이름).
    expect(first.itemCode).not.toBe('출하검사품목');
    // ⛔ `warehouseId` 를 배분의 창고로 읽을 칸이 없다 — 출하 헤더에서 온다.
    expect(first.warehouseId).not.toBe(Number(ids.warehouse2));
  });

  it('D-5 ⭐ oqcPassed — 검사 대상이 아닌 배분은 true 다(계약 명시)', async () => {
    const { body } = await detail(made.shipmentA);
    // 픽스처의 지시 라인은 `shipping_inspection_required = false` 다 ⇒ 전건 true.
    expect(body.lines.flatMap((l) => l.allocations).map((a) => a.oqcPassed)).toEqual([
      true,
      true,
      true,
    ]);
    // ⭐ 검사 필수 라인은 결과가 없으면 false 다 — 같은 축에 값이 둘이라야 「늘 true」가 죽는다.
    const inspected = await detail(made.shipmentInspected);
    expect(inspected.body.lines[0].allocations[0].oqcPassed).toBe(false);
  });

  it('D-6 packedQty 는 HU 가 없으면 0 · 있으면 배정 «전량»이다', async () => {
    const { body } = await detail(made.shipmentA);
    const [packed, unpacked] = body.lines[0].allocations;

    expect(packed).toMatchObject({ packedQty: 5, allocatedQty: 5 });
    expect(packed.handlingUnitId).not.toBeNull();
    expect(unpacked).toMatchObject({ packedQty: 0, allocatedQty: 5 });
    expect(unpacked.handlingUnitId).toBeNull();
  });

  it('D-7 goodsIssueLineId 는 널을 «받는» 칸이다 — 키가 있고 값이 null 이다', async () => {
    const { body } = await detail(made.shipmentA);
    // ⭐ 이 슬라이스의 판정(§3-2 ⓐ)에서는 출하 처리가 값을 채운다 — PR ④ e2e 가 그것을 본다.
    //   여기서 보는 것은 「출하 처리를 거치지 않은 행에서 키가 살아 있다」다.
    for (const lineBody of body.lines) {
      expect(lineBody).toHaveProperty('goodsIssueLineId', null);
    }
  });

  // ── 픽스처 ────────────────────────────────────────────────────────────────
  async function makeMasters(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({
      orderBy: { business_unit_id: 'asc' },
    });
    ids.plant = plant.plant_id;
    for (const [key, suffix] of [
      ['warehouse', 'WH1'],
      ['warehouse2', 'WH2'],
    ] as const) {
      const warehouse = await prisma.warehouse.create({
        data: {
          plant_id: plant.plant_id,
          business_unit_id: unit.business_unit_id,
          warehouse_code: `${PREFIX}-${suffix}`,
          warehouse_name: `출하검사창고${suffix}`,
          warehouse_type_code: 'FINISHED',
          management_level_code: 'WAREHOUSE',
        },
      });
      ids[key] = warehouse.warehouse_id;
    }
    const [uom] = await prisma.uom.findMany({ take: 1, orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '출하검사품목',
        item_type_code: 'FINISHED',
        base_uom_id: ids.uom,
      },
    });
    ids.item = item.item_id;
    for (const [key, suffix] of [
      ['customer', 'C1'],
      ['customer2', 'C2'],
    ] as const) {
      const partner = await prisma.partner.create({
        data: { partner_code: `${PREFIX}-${suffix}`, partner_name: `출하검사파트너${suffix}` },
      });
      ids[key] = partner.partner_id;
    }
    // ⭐ 셋이다 — `A` 에 배분을 «둘» 달아야 「조인으로 바꾸면 헤더가 중복된다」가 드러난다
    //   (변이 M-10 이 배분 한 개짜리 픽스처에서 «살아남았다» · README §6-3 ⑵).
    for (const [key, suffix] of [
      ['lotA', 'LOT-A'],
      ['lotB', 'LOT-B'],
      ['lotC', 'LOT-C'],
      ['lotD', 'LOT-D'],
      ['lotE', 'LOT-E'],
    ] as const) {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-${suffix}`,
          item_id: ids.item,
          lot_type_code: 'PRODUCT',
          plant_id: plant.plant_id,
          initial_qty: 100,
          uom_id: ids.uom,
          source_type_code: 'SHIPMENT_REQUEST',
          source_id: 1n,
          status_code: 'ACTIVE',
        },
      });
      ids[key] = lot.lot_id;
    }
  }

  async function makeShipments(): Promise<void> {
    // 지시 1 — 라인 하나가 «배정 = 예약 합»(피킹 완료) · 지시 2 — 라인 0건 · 지시 3 — 미달.
    made.request1 = Number(await makeRequest('R1', ids.customer, { allocated: 10, reserved: 10 }));
    made.request2 = Number(await makeRequest('R2', ids.customer2, null));
    made.request3 = Number(await makeRequest('R3', ids.customer, { allocated: 10, reserved: 4 }));
    // ⭐ 검사 «필수»인 지시 — 결과가 0건이라 `oqcPassed` 가 false 여야 한다. 같은 축에 값이
    //   둘이라야 「늘 true 로 내린다」 변이가 죽는다(§6-3 ⑵).
    made.request4 = Number(
      await makeRequest('R4', ids.customer, { allocated: 10, reserved: 10, inspection: true }),
    );

    made.shipmentA = Number(
      await makeShipment('A', made.request1, ids.warehouse, {
        status: 'UNCONFIRMED',
        shippedAt: new Date('2026-08-20T01:00:00.000Z'),
        // 라인 둘 — 1번에 배분 둘(첫째가 포장됨) · 2번에 배분 하나.
        lines: [{ lots: [ids.lotA, ids.lotC], packedIndex: 0 }, { lots: [ids.lotD] }],
        vehicleNo: '51C-00001',
      }),
    );
    made.shipmentB = Number(
      await makeShipment('B', made.request3, ids.warehouse, {
        status: 'UNCONFIRMED',
        shippedAt: new Date('2026-08-21T23:30:00.000Z'),
        lines: [{ lots: [ids.lotB] }],
        expedited: true,
        expediteReason: '고객 라인 정지',
      }),
    );
    await makeShipment('C', made.request2, ids.warehouse2, {
      status: 'CONFIRMED',
      shippedAt: new Date('2026-08-22T05:00:00.000Z'),
    });
    await makeShipment('D', made.request1, ids.warehouse, {
      status: 'CANCELLED',
      shippedAt: new Date('2026-08-22T06:00:00.000Z'),
    });
    await makeShipment('NULLS', made.request1, ids.warehouse, {
      status: 'UNCONFIRMED',
      shippedAt: null,
    });
    made.shipmentInspected = Number(
      await makeShipment('E', made.request4, ids.warehouse, {
        status: 'UNCONFIRMED',
        shippedAt: new Date('2026-08-22T07:00:00.000Z'),
        lines: [{ lots: [ids.lotE] }],
      }),
    );
    await makeShipment('OUT', made.request1, ids.warehouse, {
      status: 'UNCONFIRMED',
      shippedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
  }

  async function makeRequest(
    suffix: string,
    customerId: bigint,
    line: { allocated: number; reserved: number; inspection?: boolean } | null,
  ): Promise<bigint> {
    const header = await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-${suffix}`,
        customer_id: customerId,
        ship_to_partner_id: customerId,
        requested_ship_date: new Date('2026-08-20T00:00:00.000Z'),
        status_code: 'REGISTERED',
      },
    });
    if (line !== null) {
      const created = await prisma.shipment_request_line.create({
        data: {
          shipment_request_id: header.shipment_request_id,
          line_no: 1,
          item_id: ids.item,
          uom_id: ids.uom,
          requested_qty: 20,
          allocated_qty: line.allocated,
          shipping_inspection_required: line.inspection ?? false,
        },
      });
      await prisma.inventory_reservation.create({
        data: {
          reservation_no: `${PREFIX}-${suffix}-RS`,
          item_id: ids.item,
          lot_id: ids.lotA,
          warehouse_id: ids.warehouse,
          reserved_qty: line.reserved,
          uom_id: ids.uom,
          status_code: 'RESERVED',
          reservation_type_code: 'SHIPMENT',
          source_document_type_code: 'SHIPMENT_REQUEST_LINE',
          source_document_id: created.shipment_request_line_id,
        },
      });
    }
    return header.shipment_request_id;
  }

  async function makeShipment(
    suffix: string,
    requestId: number,
    warehouseId: bigint,
    opts: {
      status: string;
      shippedAt: Date | null;
      /**
       * 라인마다 배분 LOT 목록. ⭐ 라인 둘 · 배분 수 갈림(2·1) · HU 있음/없음이 모두 이 축에서
       * 선다 — 「첫 라인만 본다」·「배분을 한 라인에 모은다」·「packedQty 를 늘 0 으로」가 드러난다.
       */
      lines?: { lots: bigint[]; packedIndex?: number }[];
      expedited?: boolean;
      expediteReason?: string;
      vehicleNo?: string;
    },
  ): Promise<bigint> {
    const shipment = await prisma.shipment.create({
      data: {
        shipment_no: `${PREFIX}-${suffix}`,
        shipment_request_id: BigInt(requestId),
        warehouse_id: warehouseId,
        status_code: opts.status,
        shipped_at: opts.shippedAt,
        expedited: opts.expedited ?? false,
        expedite_reason: opts.expediteReason ?? null,
        vehicle_no: opts.vehicleNo ?? null,
      },
    });
    const requestLine = await prisma.shipment_request_line.findFirst({
      where: { shipment_request_id: BigInt(requestId) },
    });
    for (const [index, spec] of (opts.lines ?? []).entries()) {
      if (requestLine === null) break;
      const line = await prisma.shipment_line.create({
        data: {
          shipment_id: shipment.shipment_id,
          line_no: index + 1,
          shipment_request_line_id: requestLine.shipment_request_line_id,
          item_id: ids.item,
          shipped_qty: 5,
          uom_id: ids.uom,
        },
      });
      for (const [lotIndex, lotId] of spec.lots.entries()) {
        await prisma.shipment_lot_allocation.create({
          data: {
            shipment_line_id: line.shipment_line_id,
            lot_id: lotId,
            allocated_qty: 5,
            uom_id: ids.uom,
            handling_unit_id: lotIndex === spec.packedIndex ? await makeHandlingUnit() : null,
          },
        });
      }
    }
    return shipment.shipment_id;
  }

  /** 포장된 배분 한 개를 위한 HU — `packedQty` 가 0 / 배정 전량 두 갈래로 갈리는 축이다. */
  async function makeHandlingUnit(): Promise<bigint> {
    made.hu = (made.hu ?? 0) + 1;
    const unit = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-HU${made.hu}`,
        handling_unit_type_code: 'PALLET',
        status_code: 'OPEN',
        warehouse_id: ids.warehouse,
      },
    });
    return unit.handling_unit_id;
  }

  async function makeUser(): Promise<void> {
    // 계약이 403 을 선언하지 않은 조회다 — 권한 없이 세션만 있으면 된다(§1-1).
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출하조회프로브', status_code: 'EMPLOYED' },
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
  }

  async function cleanup(): Promise<void> {
    for (const sql of [
      `DELETE FROM logistics.shipment_lot_allocation WHERE shipment_line_id IN (
         SELECT shipment_line_id FROM logistics.shipment_line WHERE shipment_id IN (
           SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'))`,
      `DELETE FROM logistics.shipment_line WHERE shipment_id IN (
         SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.inventory_reservation WHERE reservation_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request
          WHERE shipment_request_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});
