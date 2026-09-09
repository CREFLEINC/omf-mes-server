/**
 * 출하작업지시 조회 3건 — 단건(PR ③b) · **목록 14축**(`GET …/shipment-requests`) ·
 * **요약**(`GET …/shipment-requests/summary`) — 뒤 둘이 I-22 PR ④ 다.
 * 화면 `W-04-02`(목록·요약·상세) · `M-04-01`(피킹).
 *
 * ⭐ 세 오퍼레이션이 픽스처 빌더를 공용으로 쓴다 — 목록과 상세가 갈리면 그 자리에서 드러난다.
 * ⭐ 축마다 값을 둘 이상 세웠다(README §6-3 ⑵) — 고객≠배송처 · `sales_order_id` 있음/없음 ·
 *   `ship_time_slot_code` 값/널 · 라인의 널 3칸 값/널 · 라인당 LOT 둘 · 예약 유형 둘 ·
 *   검사 결과 4종 × 상태 2종 × 회차 2 · 진행 6값.
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`SRE2E`)로만 한다.
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

const LOGIN_ID = 'e2e-shipment-request-probe';
const PASSWORD = 'SR-출하작업지시-비밀번호';
const PREFIX = 'SRE2E';
const BASE = '/api/logistics/shipment-requests';
/** ⭐ 물리에 저장하는 상태값 — 응답의 `statusCode` 는 이것이 «아니라» 상수 `REGISTERED` 다. */
const STORED_STATUS = 'STORED-NOT-EMITTED';
const AXIS = 'SHIPMENT_REQUEST_LINE';
/**
 * ⭐ 목록·요약 질의의 «기본 창». 픽스처가 전부 이 이틀 안에 있고 다른 스위트의 출하작업지시는
 * 밖에 있다(`logistics-sales-order` 2026-08-15 · `quality-disposition` 2026-07-01 · 실측).
 */
const WINDOW = { shipDateFrom: '2026-08-13', shipDateTo: '2026-08-14' };
const PROGRESS_CODES = [
  'NOT_ALLOCATED',
  'PARTIALLY_ALLOCATED',
  'PICKING',
  'PICKED',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
] as const;

function validator(path: string): ValidateFunction {
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

interface PickBody {
  lotId: number;
  lotNo?: string;
  pickedQty: number;
  uomId: number;
  pickedAt: string;
}
interface LineBody {
  shipmentRequestLineId: number;
  lineNo: number;
  salesOrderLineId: number | null;
  itemId: number;
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
  shippedQty: number;
  uomId: number;
  customerLotRequirement: string | null;
  shippingInspectionRequired: boolean;
  minimumRemainingShelfLifeDays: number | null;
  picks: PickBody[];
}
interface ListBody {
  items: RequestBody[];
  page: { page: number; size: number; total: number };
}
interface SummaryBody {
  requestCount: number;
  requestedQtyTotal: number;
  allocatedQtyTotal: number;
  shippedQtyTotal: number;
  unallocatedQtyTotal: number;
  pendingInspectionCount: number;
  incompletePickingCount: number;
  asOf: string;
}
interface RequestBody {
  shipmentRequestId: number;
  shipmentRequestNo: string;
  salesOrderId: number | null;
  customerId: number;
  shipToPartnerId: number;
  requestedShipDate: string;
  statusCode: string;
  timeSlotCode: string | null;
  shippingInspectionStatusCode: string;
  shipmentProgressCode: string;
  lines?: LineBody[];
  versionNo?: number;
}

type Judgment = 'ACCEPTED' | 'REJECTED' | 'HELD';
interface OqcSpec {
  judgment: Judgment;
  /** 기본 `CONFIRMED`. `DRAFT` 는 롤업에 안 든다. */
  status?: 'CONFIRMED' | 'DRAFT';
  round?: number;
}
interface PickSpec {
  reserved: number;
  released?: number;
  consumed?: number;
  /** 라인이 가진 LOT 둘 중 하나. */
  lot?: 'a' | 'b';
  /** ⭐ `lot_id` 가 NULL 인 예약 — 물리가 nullable 이라 만들 수 있다. */
  noLot?: boolean;
  /** ⛔ 다른 원천 유형의 예약 — 축이 (유형, id) 둘이 아니면 여기서 섞인다. */
  typeCode?: string;
  /** ⭐ 예약 상태 — 질의가 이 축으로 좁히지 «않는다»(통보 241). */
  statusCode?: string;
}
interface LineSpec {
  requested: number;
  allocated: number;
  shipped?: number;
  required?: boolean;
  item?: 1 | 2;
  uom?: 1 | 2;
  salesOrderLine?: boolean;
  lotRequirement?: string;
  shelfLife?: number;
  picks?: PickSpec[];
  /** 이 라인의 LOT 을 `target_id` 로 겨눈 OQC(그때 `lot_id` 는 널이다). */
  oqc?: OqcSpec[];
  /** ⭐ `target_id` 는 «바깥» LOT 인데 `lot_id` 가 이 라인의 LOT 인 OQC — 병존의 우선순위를 죽인다. */
  oqcSplit?: OqcSpec;
}
interface RequestSpec {
  lines: LineSpec[];
  /** ⭐ 두 번째 고객·배송처 — 필터의 「안 걸리는 행」이 없으면 그 절이 공허하다(§6-3 ⑵). */
  partner?: 2;
  salesOrder?: boolean;
  timeSlot?: string;
  versionNo?: number;
  shipDate?: string;
  /** `target_type_code='SHIPMENT_REQUEST'` 인 OQC. `lot` 이 `'own'` 이면 첫 라인의 LOT 을 적는다. */
  headerOqc?: (OqcSpec & { lot?: 'own' | 'outside' })[];
}

interface MadeLine {
  id: number;
  lotA: number;
  lotB: number;
  salesOrderLineId: number | null;
}
interface Made {
  id: number;
  lines: MadeLine[];
}

describe('출하작업지시 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = {
    plant: 0n,
    warehouse: 0n,
    worker: 0n,
    uom1: 0n,
    uom2: 0n,
    item1: 0n,
    item2: 0n,
    customer: 0n,
    shipTo: 0n,
    customer2: 0n,
    shipTo2: 0n,
    salesOrder: 0n,
    outsideLot: 0n,
  };
  const made: Record<string, Made> = {};
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeRequests();
    await makeUser();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── D-1 ~ D-7 · 응답 모양 · 세 스키마의 출처 · 널 정책 ────────────────────
  it('D-1 단건이 계약 ShipmentRequest 스키마를 만족하고 lines 를 싣는다', async () => {
    const body = await detail(made.LINE.id);

    const validate = validator('/logistics/shipment-requests/{shipmentRequestId}');
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(body.lines).toHaveLength(2);
    expect((body.lines as LineBody[]).map((line) => line.lineNo)).toEqual([1, 2]);
  });

  it('D-2 ShipmentRequest 의 required 8칸이 «제 출처»에서 온다', async () => {
    const body = await detail(made.HDR.id);
    const stored = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: BigInt(made.HDR.id) },
    });

    // ⭐ ajv 는 «타입»만 본다 — 여덟 칸을 뒤바꿔도 통과한다(§6-3 ⑴). 그래서 값으로 못 박는다.
    //   고객·배송처가 «다른» 파트너이고 진행·검사가 «다른» 문자열이라 뒤바꿈이 값에서 드러난다.
    expect(body).toMatchObject({
      shipmentRequestId: Number(stored.shipment_request_id),
      shipmentRequestNo: `${PREFIX}-HDR`,
      customerId: Number(ids.customer),
      shipToPartnerId: Number(ids.shipTo),
      requestedShipDate: '2026-08-13',
      statusCode: 'REGISTERED',
      shippingInspectionStatusCode: 'REJECTED',
      shipmentProgressCode: 'PICKING',
    });
    expect(Number(ids.customer)).not.toBe(Number(ids.shipTo));
    // `requested_ship_date` 를 `created_at` 에서 길어 오면 오늘 날짜가 나온다.
    expect(body.requestedShipDate).not.toBe(stored.created_at.toISOString().slice(0, 10));
  });

  it('D-3 ShipmentRequestLine 의 required 10칸이 «제 출처»에서 온다', async () => {
    const lines = (await detail(made.LINE.id)).lines as LineBody[];

    expect(lines[0]).toMatchObject({
      lineNo: 1,
      itemId: Number(ids.item1),
      requestedQty: 120,
      allocatedQty: 90,
      pickedQty: 60,
      shippedQty: 30,
      uomId: Number(ids.uom2),
      shippingInspectionRequired: true,
    });
    expect(lines[1]).toMatchObject({
      lineNo: 2,
      itemId: Number(ids.item2),
      requestedQty: 240,
      allocatedQty: 150,
      pickedQty: 90,
      shippedQty: 45,
      uomId: Number(ids.uom1),
      shippingInspectionRequired: false,
    });
    // ⛔ `Set(...).size` 로는 안 잠긴다 — 「서로 다르다」만 보므로 `line_no` 에서 길어 와도
    //   통과한다. 저장된 PK 배열과 «통째로» 맞춘다.
    expect(lines.map((line) => line.shipmentRequestLineId)).toEqual(
      made.LINE.lines.map((line) => line.id),
    );
    expect(lines.map((line) => line.picks.length)).toEqual([1, 2]);
  });

  it('D-4 ShipmentLinePickedLot 의 5칸이 «제 출처»에서 온다(picks 는 예약 행이다)', async () => {
    const lines = (await detail(made.LINE.id)).lines as LineBody[];
    const stored = await prisma.inventory_reservation.findMany({
      where: { source_document_type_code: AXIS, source_document_id: BigInt(made.LINE.lines[1].id) },
      orderBy: { inventory_reservation_id: 'asc' },
      include: { lot: { select: { lot_no: true } } },
    });

    expect(stored).toHaveLength(2);
    // LOT 이 둘이라 「첫 개만 본다」·「lotId 를 itemId 에서」 가 값에서 드러난다.
    expect(lines[1].picks.map((pick) => pick.lotId)).toEqual([
      made.LINE.lines[1].lotA,
      made.LINE.lines[1].lotB,
    ]);
    expect(lines[1].picks.map((pick) => pick.lotNo)).toEqual(stored.map((row) => row.lot?.lot_no));
    expect(lines[1].picks.map((pick) => pick.pickedQty)).toEqual([75, 15]);
    expect(lines[1].picks.map((pick) => pick.uomId)).toEqual([Number(ids.uom1), Number(ids.uom1)]);
    expect(lines[1].picks.map((pick) => pick.pickedAt)).toEqual(
      stored.map((row) => row.created_at.toISOString()),
    );
    expect(lines[1].picks[0].lotId).not.toBe(lines[1].picks[0].uomId);
  });

  it('D-5 널을 «받는» 5칸은 null 로 내린다(값이 있으면 값으로)', async () => {
    const nulls = await detail(made.NULLS.id);
    const hdr = await detail(made.HDR.id);

    expect(nulls).toHaveProperty('salesOrderId', null);
    expect(nulls).toHaveProperty('timeSlotCode', null);
    const line = (nulls.lines as LineBody[])[0];
    expect(line).toHaveProperty('salesOrderLineId', null);
    expect(line).toHaveProperty('customerLotRequirement', null);
    expect(line).toHaveProperty('minimumRemainingShelfLifeDays', null);
    // ⭐ 같은 축에 값이 둘이라야 「늘 널로 내린다」 변이가 죽는다(§6-3 ⑵).
    expect(hdr.salesOrderId).toBe(Number(ids.salesOrder));
    expect(hdr.timeSlotCode).toBe('MORNING');
    const withValues = (await detail(made.LINE.id)).lines as LineBody[];
    expect(withValues[0].salesOrderLineId).toBe(made.LINE.lines[0].salesOrderLineId);
    expect(withValues[0].customerLotRequirement).toBe('고객 LOT 조건 1');
    expect(withValues[0].minimumRemainingShelfLifeDays).toBe(7);
  });

  it('D-6 널을 «못 받는» 선택 칸은 키를 생략한다 — versionNo 는 저장값이다', async () => {
    const body = await detail(made.HDR.id);

    // `lines`·`versionNo` 는 `type:['x','null']` 이 «아니다» — 널로 내리면 ajv 가 깨진다.
    expect(body.versionNo).toBe(5);
    expect((await detail(made.NULLS.id)).versionNo).toBe(1);
    expect(body.lines).toBeDefined();
  });

  it('D-7 statusCode 는 상수 REGISTERED 다 — 저장값을 읽지 않는다', async () => {
    const stored = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: BigInt(made.HDR.id) },
    });

    expect(stored.status_code).toBe(STORED_STATUS);
    expect((await detail(made.HDR.id)).statusCode).toBe('REGISTERED');
  });

  // ── D-8 ~ D-11 · pickedQty 롤업 ─────────────────────────────────────────
  it('D-8 pickedQty 가 Σ(reserved − released) 다', async () => {
    const body = await detail(made.REL.id);

    // 예약 50 · 해제 20 ⇒ 30. 안 빼면 50 이 되고 진행도 PICKED → PARTIALLY_ALLOCATED 로 흔들린다.
    expect((body.lines as LineBody[])[0].pickedQty).toBe(30);
    expect((body.lines as LineBody[])[0].allocatedQty).toBe(30);
    expect(body.shipmentProgressCode).toBe('PICKED');
    // ⭐ `picks[]` 는 «예약 행»이라 그 `pickedQty` 는 `reserved_qty` 그대로다(§1-4-1 — 넷이 1:1).
    //   라인 롤업(30)과 갈리는 것이 정상이고, 여기서 빼면 두 축이 같은 뜻이 되어 버린다.
    expect((body.lines as LineBody[])[0].picks.map((pick) => pick.pickedQty)).toEqual([50]);
  });

  it('D-9 pickedQty 가 consumed 를 «빼지 않는다» — 피킹 직후에도 PICKED 다', async () => {
    const body = await detail(made.CONS.id);

    // ⓒ안에서 피킹은 `consumed = reserved` 로 끝난다 — 빼면 P = 0 이 되어 PICKED 가 영영 안 나온다.
    expect((body.lines as LineBody[])[0].pickedQty).toBe(80);
    expect(body.shipmentProgressCode).toBe('PICKED');
  });

  it('D-10 예약 축이 (원천 유형, 원천 id) 둘이다 — 자재 예약이 안 섞인다', async () => {
    const body = await detail(made.MIX.id);
    const line = (body.lines as LineBody[])[0];

    const foreign = await prisma.inventory_reservation.count({
      where: {
        source_document_id: BigInt(made.MIX.lines[0].id),
        source_document_type_code: { not: AXIS },
      },
    });
    expect(foreign).toBe(1);
    expect(line.pickedQty).toBe(50);
    expect(line.picks).toHaveLength(1);
    expect(body.shipmentProgressCode).toBe('PICKED');
  });

  it('D-25 lot_id 가 널인 예약도 picks[] 에 실린다 — 오늘은 lotId 가 0 이다', async () => {
    const line = ((await detail(made.EDGE.id)).lines as LineBody[])[0];

    // ⛔ 널 행을 걸러 내면 라인 롤업(60)과 Σ picks[].pickedQty 가 갈린다 — 그래서 «싣는다».
    expect(line.picks).toHaveLength(3);
    expect(line.pickedQty).toBe(60);
    // ⚠ 오늘의 동작을 잠근다 — `lotId: 0`(어느 LOT 도 아니다)이 옳은 답인지는 설계 문의 대기.
    expect(line.picks[1]).toMatchObject({ lotId: 0, pickedQty: 20 });
    expect(line.picks[1]).not.toHaveProperty('lotNo');
    expect(line.picks[0].lotNo).toBe(`${PREFIX}-EDGE-L1A`);
  });

  it('D-26 예약 status_code 가 달라도 롤업이 «센다»', async () => {
    const stored = await prisma.inventory_reservation.count({
      where: { reservation_no: { startsWith: `${PREFIX}-` }, status_code: 'CLOSED' },
    });
    const line = ((await detail(made.EDGE.id)).lines as LineBody[])[0];

    // ⚠ 통보 241 — `released_qty` 를 «쓰는» 코드가 0개라 되돌린 예약을 상태로도 수량으로도
    //   못 뺀다. 상태로 좁히는 절을 «추가»하면 이 단언이 깨진다.
    expect(stored).toBe(1);
    expect(line.picks.map((pick) => pick.pickedQty)).toEqual([10, 20, 30]);
    expect(line.pickedQty).toBe(60);
  });

  it('D-11 0.1 + 0.2 로 피킹한 라인이 PICKED 다', async () => {
    const body = await detail(made.DEC.id);

    // ⛔ `Number` 로 접으면 0.30000000000000004 ≠ 0.3 이라 PICKED 가 안 나온다(§6-3 ⑸).
    expect((body.lines as LineBody[])[0].pickedQty).toBe(0.3);
    expect(body.shipmentProgressCode).toBe('PICKED');
  });

  // ── D-12 ~ D-17 · shipmentProgressCode 6값 ──────────────────────────────
  it('D-12 배정 합이 0 이면 NOT_ALLOCATED 다', async () => {
    // ⛔ 계약 문자 그대로(「뒤가 이긴다」)면 공허참으로 SHIPPED 가 나온다(R-7 ⓐ).
    expect((await detail(made.PROG_F.id)).shipmentProgressCode).toBe('NOT_ALLOCATED');
  });

  it('D-13 0 < 배정 < 요청 이고 피킹이 진행 중이면 PARTIALLY_ALLOCATED 다', async () => {
    expect((await detail(made.PROG_B.id)).shipmentProgressCode).toBe('PARTIALLY_ALLOCATED');
  });

  it('D-14 배정 = 요청 이고 피킹이 모자라면 PICKING 이다', async () => {
    expect((await detail(made.PROG_A.id)).shipmentProgressCode).toBe('PICKING');
  });

  it('D-15 부분 배정이어도 피킹 = 배정 이면 PICKED 다', async () => {
    // 「부분 배정은 영영 PARTIALLY_ALLOCATED」로 짜면 깨진다(R-7 ⓑ).
    expect((await detail(made.PROG_B2.id)).shipmentProgressCode).toBe('PICKED');
  });

  it('D-16 0 < 출하 < 배정 이면 PARTIALLY_SHIPPED 다', async () => {
    expect((await detail(made.PROG_D.id)).shipmentProgressCode).toBe('PARTIALLY_SHIPPED');
  });

  it('D-17 출하 = 배정 이면 SHIPPED 다', async () => {
    expect((await detail(made.PROG_E.id)).shipmentProgressCode).toBe('SHIPPED');
  });

  // ── D-18 ~ D-23 · shippingInspectionStatusCode 롤업 ─────────────────────
  it('D-18 검사 5값이 전건 나온다 — 롤업은 «가장 나쁜 것»이 이긴다', async () => {
    // 다섯 건 모두 라인 값이 «섞여» 있어 우선순위를 어느 칸에서 뒤집어도 하나는 깨진다.
    expect((await detail(made.INS_NR.id)).shippingInspectionStatusCode).toBe('NOT_REQUIRED');
    expect((await detail(made.INS_PASS.id)).shippingInspectionStatusCode).toBe('PASSED');
    expect((await detail(made.INS_PEND.id)).shippingInspectionStatusCode).toBe('PENDING');
    expect((await detail(made.INS_HELD.id)).shippingInspectionStatusCode).toBe('HELD');
    expect((await detail(made.INS_REJ.id)).shippingInspectionStatusCode).toBe('REJECTED');
  });

  it('D-19 DRAFT OQC 결과는 롤업에 안 든다', async () => {
    const stored = await prisma.inspection_result.count({
      where: { inspection_result_no: { startsWith: `${PREFIX}-` }, status_code: 'DRAFT' },
    });

    expect(stored).toBe(1);
    // 합격(ACCEPTED)인데 DRAFT 다 — 세면 PASSED 가 된다.
    expect((await detail(made.INS_DRAFT.id)).shippingInspectionStatusCode).toBe('PENDING');
  });

  it('D-20 재검사 2회차 합격이 1회차 불합격을 덮는다', async () => {
    expect((await detail(made.INS_ROUND.id)).shippingInspectionStatusCode).toBe('PASSED');
  });

  it('D-21 헤더 대상 OQC 가 «모든» 필수 라인을 물들인다', async () => {
    const body = await detail(made.INS_HDR.id);

    // 라인 둘 다 LOT 축 결과가 0건이다 — 헤더 갈래를 빼면 둘 다 PENDING 이 된다.
    expect(body.lines).toHaveLength(2);
    expect(body.shippingInspectionStatusCode).toBe('PASSED');
  });

  it('D-22 헤더 대상이어도 lot_id 가 그 라인 밖이면 물들이지 «않는다»', async () => {
    const body = await detail(made.INS_HDRLOT.id);

    // ⛔ R-5 — `lot_id` 는 `target_type_code` 와 병존한다. 버리면 PASSED 가 나온다.
    expect(body.shippingInspectionStatusCode).toBe('PENDING');
  });

  it('D-23 LOT 대상 OQC 는 target_id 보다 lot_id 를 먼저 본다', async () => {
    // `target_id` 는 바깥 LOT 이고 `lot_id` 가 이 라인의 LOT 이다 — 질의가 `lot_id` 축을
    // 안 걸면 행 자체가 안 딸려 오고, 판정이 `target_id` 만 보면 대상에서 빠진다.
    expect((await detail(made.INS_SPLIT.id)).shippingInspectionStatusCode).toBe('REJECTED');
  });

  it('D-24 없는 shipmentRequestId 는 404 다', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/${made.HDR.id + 9_999_999}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── L-1 ~ L-53 · 목록 14축 + 요약(PR ④) ─────────────────────────────────
  it('L-1 목록이 계약 스키마를 만족하고 항목이 «단건 응답과 같다»', async () => {
    const body = await list();

    const validate = validator('/logistics/shipment-requests');
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // ⭐ 목록이 «자기» 뷰를 따로 만들면 여기서 갈린다 — 헤더 8칸·라인 10칸·picks 5칸을 통째로
    //   대조하므로 §6-3 ⑴ 의 「출처 뒤바꿈」이 목록 스키마에서도 잡힌다(D-2·D-3·D-4 와 짝).
    expect(body.items.find((item) => item.shipmentRequestNo === `${PREFIX}-LINE`)).toEqual(
      await detail(made.LINE.id),
    );
  });

  it('L-2 · L-2b shipDateFrom 이 없으면 목록도 «요약도» 400 REQUIRED 다', async () => {
    for (const path of [BASE, `${BASE}/summary`]) {
      const response = await request(app.getHttpServer())
        .get(path)
        .query({ shipDateTo: WINDOW.shipDateTo })
        .set('Cookie', cookie)
        .expect(400);
      expect((response.body as { errors: unknown[] }).errors).toEqual([
        expect.objectContaining({ field: 'shipDateFrom', code: 'REQUIRED' }),
      ]);
    }
  });

  it('L-3 · L-4 shipDateFrom·shipDateTo 가 «같은 날»이면 그 날 것이 걸린다', async () => {
    // 경계를 `>`·`<` 로 조이면 같은 날이 통째로 빠진다.
    const oneDay = nos(await listRaw({ shipDateFrom: '2026-08-13', shipDateTo: '2026-08-13', size: 200 }));
    expect(oneDay).toContain(`${PREFIX}-HDR`);
    expect(oneDay).not.toContain(`${PREFIX}-LINE`);

    const from14 = nos(await listRaw({ shipDateFrom: '2026-08-14', size: 200 }));
    expect(from14).not.toContain(`${PREFIX}-HDR`);
    expect(from14).toContain(`${PREFIX}-OUT`);
    // `To` 를 주면 바깥이 빠진다 — 두 절이 «따로» 산다.
    expect(nos(await list())).not.toContain(`${PREFIX}-OUT`);

    // 0건이어도 봉투가 선다 — `count(*) OVER ()` 가 행이 없으면 아무것도 안 낸다.
    const empty = await listRaw({ shipDateFrom: '2099-01-01', shipDateTo: '2099-01-02' });
    expect(empty.items).toEqual([]);
    expect(empty.page.total).toBe(0);
  });

  it('L-5 customerId·shipToPartnerId 각각이 안 걸리는 행을 뺀다', async () => {
    // 고객과 배송처가 «다른» 파트너라 두 절을 뒤바꾸면 값에서 드러난다(§6-3 ⑵).
    expect(Number(ids.customer)).not.toBe(Number(ids.shipTo));

    const byCustomer = nos(await list({ customerId: Number(ids.customer) }));
    expect(byCustomer).toContain(`${PREFIX}-HDR`);
    expect(byCustomer).not.toContain(`${PREFIX}-CUST2`);
    expect(nos(await list({ shipToPartnerId: Number(ids.shipTo2) }))).toEqual([`${PREFIX}-CUST2`]);
  });

  it('L-6 · L-7 itemId 가 그 품목 라인이 «없는» 건을 빼고 헤더가 중복되지 않는다', async () => {
    const body = await list({ itemId: Number(ids.item2) });

    expect(nos(body).sort()).toEqual([`${PREFIX}-DUP`, `${PREFIX}-LINE`]);
    // ⛔ 조인이면 같은 품목 라인 «둘»인 DUP 이 두 번 나와 total 이 3 이 된다.
    expect(made.DUP.lines).toHaveLength(2);
    expect(body.page.total).toBe(2);
  });

  it('L-8 timeSlotCode 필터가 NULL 행과 다른 시간대 행을 뺀다', async () => {
    // 축에 값이 셋이다 — MORNING · AFTERNOON · NULL(나머지 전부).
    expect(nos(await list({ timeSlotCode: 'MORNING' }))).toEqual([`${PREFIX}-HDR`]);
    expect(nos(await list({ timeSlotCode: 'AFTERNOON' }))).toEqual([`${PREFIX}-TSPM`]);
  });

  it('L-9 pickingCompleteOnly 가 라인 0건(SR-G)을 «안» 낸다 — 공허참', async () => {
    expect(made.SR_G.lines).toHaveLength(0);
    expect(nos(await list())).toContain(`${PREFIX}-SR_G`);

    // ⛔ `EXISTS(라인)` 앞 절을 빼면 라인 0건이 `NOT EXISTS` 로 참이 되어 딸려 온다.
    expect(nos(await list({ pickingCompleteOnly: true }))).not.toContain(`${PREFIX}-SR_G`);
  });

  it('L-9b 라인 0건이어도 목록이 lines 를 «싣는다» — 빈 배열이지 키 생략이 아니다(R-9)', async () => {
    const items = (await list()).items;
    const empty = items.find((item) => item.shipmentRequestNo === `${PREFIX}-SR_G`);

    expect(empty).toHaveProperty('lines');
    expect(empty?.lines).toEqual([]);
    // 컬렉션 길이 축에 0 이 있어야 「lines 를 늘 싣는다」가 그 경계에서 잠긴다(§6-3 ⑵).
    const lengths = items.map((item) => (item.lines ?? []).length);
    expect(lengths).toContain(0);
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(3);
  });

  it('L-10 · L-11 pickingCompleteOnly 는 한 라인만 미달이어도 빼고, shippableRemainderOnly 는 한 라인만 남아도 낸다', async () => {
    const complete = nos(await list({ pickingCompleteOnly: true }));
    expect(complete).toContain(`${PREFIX}-FULL`);
    expect(complete).not.toContain(`${PREFIX}-PART`);
    // ⭐ 라인 `P` 가 Σ(reserved − released) 다 — `- released_qty` 를 빼면 50 ≥ 50 으로 새 들어온다.
    expect(complete).not.toContain(`${PREFIX}-RELPART`);

    // 정량자가 반대다 — FULL 한 픽스처가 둘을 «동시에» 반증한다(피킹 완료 ∧ 잔여 있음).
    const remainder = nos(await list({ shippableRemainderOnly: true }));
    expect(remainder).toContain(`${PREFIX}-REM`);
    expect(remainder).toContain(`${PREFIX}-FULL`);
    expect(remainder).not.toContain(`${PREFIX}-PROG_E`);

    // 계약이 한 방향만 적었다 — `false` 는 «안 거른다»(두 축 모두).
    expect(nos(await list({ pickingCompleteOnly: false }))).toEqual(nos(await list()));
    expect(nos(await list({ shippableRemainderOnly: false }))).toEqual(nos(await list()));
  });

  it('L-12 0.1 + 0.2 로 피킹한 라인이 PICKED 로 «필터»된다', async () => {
    // ⛔ SQL 쪽을 부동소수로 접으면 0.30000000000000004 ≠ 0.3 이라 이 건이 빠진다(§6-3 ⑸).
    expect(nos(await list({ shipmentProgressCode: 'PICKED' }))).toContain(`${PREFIX}-DEC`);
  });

  it('L-14~L-20 진행 6값 — 필터로 부른 목록과 응답 필드가 «같은 집합»이다', async () => {
    const all = (await list()).items;

    for (const code of PROGRESS_CODES) {
      const byField = all
        .filter((item) => item.shipmentProgressCode === code)
        .map((item) => item.shipmentRequestNo)
        .sort();
      const byFilter = nos(await list({ shipmentProgressCode: code })).sort();

      // ⛔ TS 판정(응답 칸)과 SQL 술어(필터)가 갈리면 여기서 깨진다 — 한쪽만 고치면 못 넘는다.
      expect(byFilter).toEqual(byField);
      // 6값이 «전부» 픽스처에 있어야 이 대조가 공허하지 않다(§6-3 ⑵).
      expect(byField.length).toBeGreaterThan(0);
    }
  });

  it('L-21 · L-22 A = 0 은 NOT_ALLOCATED 로, 부분 배정 + P = A 는 PICKED 로 «필터»된다', async () => {
    // ⛔ 계약 문자 그대로(「뒤가 이긴다」)면 공허참으로 SHIPPED 가 나온다(R-7 ⓐ).
    expect(nos(await list({ shipmentProgressCode: 'NOT_ALLOCATED' }))).toContain(`${PREFIX}-PROG_F`);
    expect(nos(await list({ shipmentProgressCode: 'SHIPPED' }))).not.toContain(`${PREFIX}-PROG_F`);
    expect(nos(await list({ shipmentProgressCode: 'PICKED' }))).toContain(`${PREFIX}-PROG_B2`);
  });

  it('L-24 enum 밖 shipmentProgressCode 는 400 이다', async () => {
    await request(app.getHttpServer())
      .get(BASE)
      .query({ ...WINDOW, shipmentProgressCode: 'NOT_A_CODE' })
      .set('Cookie', cookie)
      .expect(400);
  });

  it('L-25~L-34 목록의 shippingInspectionStatusCode 가 단건과 «전건» 같다', async () => {
    const byNo = new Map(
      (await list()).items.map((item) => [item.shipmentRequestNo, item.shippingInspectionStatusCode]),
    );

    // ⛔ 검사 모집단을 건마다 안 읽고 «한 방»으로 읽으므로, 축을 첫 건으로 좁히면 나머지가 샌다.
    for (const key of [
      'INS_NR', 'INS_PASS', 'INS_PEND', 'INS_HELD', 'INS_REJ',
      'INS_DRAFT', 'INS_ROUND', 'INS_HDR', 'INS_HDRLOT', 'INS_SPLIT',
    ]) {
      expect(byNo.get(`${PREFIX}-${key}`)).toBe(
        (await detail(made[key].id)).shippingInspectionStatusCode,
      );
    }
    // 그 축에 값이 다섯이라야 위 대조가 공허하지 않다(§6-3 ⑵).
    expect(new Set([...byNo.values()]).size).toBeGreaterThanOrEqual(5);
  });

  it('L-35 shippingInspectionRequired 필터가 안 걸리는 행을 뺀다', async () => {
    const required = nos(await list({ shippingInspectionRequired: true }));
    expect(required).toContain(`${PREFIX}-HDR`);
    expect(required).not.toContain(`${PREFIX}-NULLS`);

    const notRequired = nos(await list({ shippingInspectionRequired: false }));
    expect(notRequired).toContain(`${PREFIX}-NULLS`);
    expect(notRequired).not.toContain(`${PREFIX}-HDR`);
  });

  it('L-36 statusCode 질의를 줘도 목록이 «안» 좁혀진다', async () => {
    const all = await list();

    // 계약이 「이 축으로는 거를 수 없다」라 적었다 — 저장값으로 걸어도, 없는 값으로 걸어도 같다.
    expect(nos(await list({ statusCode: 'NO-SUCH-STATUS' }))).toEqual(nos(all));
    expect(nos(await list({ statusCode: STORED_STATUS }))).toEqual(nos(all));
    expect((await list({ statusCode: 'NO-SUCH-STATUS' })).page.total).toBe(all.page.total);
  });

  it('L-37 기본 정렬이 출하일 오름차순 + PK 오름차순이다', async () => {
    const items = (await list()).items;

    const sorted = [...items].sort((a, b) =>
      a.requestedShipDate === b.requestedShipDate
        ? a.shipmentRequestId - b.shipmentRequestId
        : a.requestedShipDate.localeCompare(b.requestedShipDate),
    );
    expect(items.map((item) => item.shipmentRequestId)).toEqual(
      sorted.map((item) => item.shipmentRequestId),
    );
    // 방향을 뒤집으면 08-13(HDR 하나뿐)이 맨 뒤로 간다 — 축에 날짜가 둘이다.
    expect(items[0].requestedShipDate).toBe('2026-08-13');
    expect(items[items.length - 1].requestedShipDate).toBe('2026-08-14');
  });

  it('L-38 sort=customerId · shipmentRequestNo 가 각각 먹는다', async () => {
    const byNo = nos(await list({ sort: 'shipmentRequestNo' }));
    // ⛔ 콜레이션에 안 기대게 «밑줄 없는» 셋으로 순서를 본다.
    expect(byNo.indexOf(`${PREFIX}-CONS`)).toBeLessThan(byNo.indexOf(`${PREFIX}-DEC`));
    expect(byNo.indexOf(`${PREFIX}-DEC`)).toBeLessThan(byNo.indexOf(`${PREFIX}-EDGE`));
    expect(byNo[0]).not.toBe(nos(await list())[0]);

    const byCustomer = (await list({ sort: 'customerId' })).items.map((item) => item.customerId);
    expect(byCustomer).toEqual([...byCustomer].sort((a, b) => a - b));
    // 고객이 둘뿐이라 «마지막»이 나중에 만든 파트너여야 방향 반전이 잡힌다.
    expect(byCustomer[byCustomer.length - 1]).toBe(Number(ids.customer2));
  });

  it('L-39 sort=allocatedQty 는 400 INVALID 다', async () => {
    const response = await request(app.getHttpServer())
      .get(BASE)
      .query({ ...WINDOW, sort: 'allocatedQty' })
      .set('Cookie', cookie)
      .expect(400);

    expect((response.body as { errors: unknown[] }).errors).toEqual([
      expect.objectContaining({ field: 'sort', code: 'INVALID' }),
    ]);
  });

  it('L-40 정렬 2차 키가 있어 쪽이 안 겹친다', async () => {
    // ⭐ `customerId` 는 값이 «둘»뿐이라 2차 키가 없으면 쪽 경계에서 행이 겹치거나 샌다.
    const all = await list();
    const seen: number[] = [];
    for (const page of [1, 2, 3, 4, 5]) {
      const body = await listRaw({ ...WINDOW, sort: 'customerId', page, size: 3 });
      seen.push(...body.items.map((item) => item.shipmentRequestId));
      // `total` 은 쪽이 아니라 필터 «전체» 기준이다 — 쪽 길이로 세면 여기서 깨진다.
      expect(body.page.total).toBe(all.page.total);
      expect(body.page).toMatchObject({ page, size: 3 });
    }

    expect(seen.length).toBe(15);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('L-41 목록이 lines 를 싣고 pickedQty·picks 가 찬다', async () => {
    const item = (await list()).items.find((row) => row.shipmentRequestNo === `${PREFIX}-LINE`);
    const lines = item?.lines ?? [];

    expect(lines.map((line) => line.pickedQty)).toEqual([60, 90]);
    expect(lines.map((line) => line.picks.length)).toEqual([1, 2]);
    expect(lines[1].picks.map((pick) => pick.lotId)).toEqual([
      made.LINE.lines[1].lotA,
      made.LINE.lines[1].lotB,
    ]);
  });

  it('L-42 예약 조회가 쪽 전체에 «한 번»이다 — 호출 «수»를 센다', async () => {
    const spy = jest.spyOn(prisma.inventory_reservation, 'findMany');
    try {
      spy.mockClear();
      const body = await list();

      // ⛔ 값 단언만으로는 1회와 N회를 못 가른다(③b 인계 ⑵) — 라인마다 부르는 변이가 초록이었다.
      expect(spy).toHaveBeenCalledTimes(1);
      // 픽스처가 「건 여럿 · 라인 여럿」이라야 N+1 변이가 이 수를 넘긴다.
      expect(body.items.length).toBeGreaterThan(5);
      expect(body.items.filter((item) => (item.lines ?? []).length > 1).length).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('L-45 요약의 질의 축이 목록과 같다 — 같은 필터면 같은 모집단이다', async () => {
    const narrow = { customerId: Number(ids.customer), timeSlotCode: 'MORNING' };
    expect((await summary(narrow)).requestCount).toBe((await list(narrow)).page.total);
    expect((await summary(narrow)).requestCount).toBe(1);

    const complete = { pickingCompleteOnly: true };
    expect((await summary(complete)).requestCount).toBe((await list(complete)).page.total);
    expect((await summary({})).requestCount).toBe((await list()).page.total);
  });

  it('L-46 요약이 0건일 때 합계 4칸이 «0» 이다(널이 아니다)', async () => {
    const card = await listSummary({ shipDateFrom: '2099-01-01', shipDateTo: '2099-01-02' });

    // ⛔ `coalesce` 를 벗기면 `sum()` 이 NULL 이라 required 8칸이 깨진다(§6-3 ⑷).
    const validate = validator('/logistics/shipment-requests/summary');
    expect(validate(card)).toBe(true);
    expect(card).toMatchObject({
      requestCount: 0,
      requestedQtyTotal: 0,
      allocatedQtyTotal: 0,
      shippedQtyTotal: 0,
      unallocatedQtyTotal: 0,
      pendingInspectionCount: 0,
      incompletePickingCount: 0,
    });
  });

  it('L-47 unallocatedQtyTotal 키가 있고 값이 맞다', async () => {
    // HDR 하나 — 요청 100 · 배정 100 ⇒ 미배정 0.
    expect(await summary({ customerId: Number(ids.customer), timeSlotCode: 'MORNING' })).toMatchObject({
      requestedQtyTotal: 100,
      allocatedQtyTotal: 100,
      unallocatedQtyTotal: 0,
    });

    // ⭐ 0 아닌 값으로 네 칸을 «각각» 못박는다 — LINE(360/240/75) + DUP(10/10/0). 넷이 서로
    //   다른 값이라 §6-3 ⑴ 의 「출처 뒤바꿈」(요청↔배정↔출하↔피킹)이 값에서 드러난다.
    expect(await summary({ itemId: Number(ids.item2) })).toMatchObject({
      requestCount: 2,
      requestedQtyTotal: 370,
      allocatedQtyTotal: 250,
      shippedQtyTotal: 75,
      unallocatedQtyTotal: 120,
    });

    // ⭐ 서버가 `numeric` 으로 «먼저 빼고 더한다» — 화면이 두 합계를 받아 다시 빼면 부동소수가
    //   샌다(실측: 470.7 ↔ 470.70000000000005). 계약이 「서버가 계산한다」라 적은 이유다.
    const wide = await summary({});
    expect(wide.unallocatedQtyTotal).toBeCloseTo(wide.requestedQtyTotal - wide.allocatedQtyTotal, 6);
    expect(wide.unallocatedQtyTotal).toBeGreaterThan(0);
  });

  it('L-48 pendingInspectionCount 가 «작업지시 건수»다 — 라인 수가 아니다', async () => {
    const pending = (await list()).items.filter(
      (item) => item.shippingInspectionStatusCode === 'PENDING',
    );
    const lineCount = pending.reduce((sum, item) => sum + (item.lines ?? []).length, 0);

    expect(pending.length).toBeGreaterThan(0);
    // 라인 수로 세면 «다른» 값이 나와야 반증이 산다(§6-3 ⑵).
    expect(lineCount).not.toBe(pending.length);
    expect((await summary({})).pendingInspectionCount).toBe(pending.length);
  });

  it('L-49 incompletePickingCount 가 pickingCompleteOnly 의 «여집합»이다', async () => {
    const card = await summary({});
    const complete = (await list({ pickingCompleteOnly: true })).page.total;

    expect(complete).toBeGreaterThan(0);
    expect(card.incompletePickingCount).toBeGreaterThan(0);
    expect(card.incompletePickingCount).toBe(card.requestCount - complete);
  });

  it('L-50 요약은 page·size·sort 를 무시한다', async () => {
    const base = await summary({});

    // ⛔ `sort` 를 읽으면 화이트리스트 밖이라 400 이 난다 — 그것 자체가 반증이다.
    expect(await summary({ page: 2, size: 1, sort: 'allocatedQty' })).toMatchObject({
      requestCount: base.requestCount,
      requestedQtyTotal: base.requestedQtyTotal,
      pendingInspectionCount: base.pendingInspectionCount,
      incompletePickingCount: base.incompletePickingCount,
    });
  });

  it('L-51 asOf 가 ISO 8601 시각이다', async () => {
    const card = await summary({});

    expect(card.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(card.asOf))).toBe(false);
  });

  it('L-53 @Get(summary) 가 @Get(:shipmentRequestId) «앞»이다 — 400 이 아니다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/summary`)
      .query(WINDOW)
      .set('Cookie', cookie)
      .expect(200);

    // ⛔ 순서가 뒤바뀌면 `{field:'shipmentRequestId', code:'INVALID'}` 400 이 나온다(③b 실측).
    expect(response.body).toHaveProperty('requestCount');
    expect(response.body).not.toHaveProperty('shipmentRequestId');
  });

  // ── 헬퍼 ────────────────────────────────────────────────────────────────
  async function detail(shipmentRequestId: number): Promise<RequestBody> {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${shipmentRequestId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as RequestBody;
  }

  async function listRaw(query: Record<string, unknown>): Promise<ListBody> {
    const response = await request(app.getHttpServer())
      .get(BASE)
      .query(query)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as ListBody;
  }

  /** 기본 창 + 한 쪽에 다 담는 크기. 픽스처가 전부 이 창 안에 있다. */
  async function list(params: Record<string, unknown> = {}): Promise<ListBody> {
    return listRaw({ ...WINDOW, size: 200, ...params });
  }

  function nos(body: ListBody): string[] {
    return body.items.map((item) => item.shipmentRequestNo);
  }

  async function listSummary(query: Record<string, unknown>): Promise<SummaryBody> {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/summary`)
      .query(query)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as SummaryBody;
  }

  async function summary(params: Record<string, unknown>): Promise<SummaryBody> {
    return listSummary({ ...WINDOW, ...params });
  }

  function no(part: string): string {
    seq += 1;
    return `${PREFIX}-${part}-${seq}`;
  }

  async function makeMasters(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.plant = plant.plant_id;
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: ids.plant,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '출하작업지시검사창고',
        warehouse_type_code: 'FINISHED',
        management_level_code: 'WAREHOUSE',
      },
    });
    ids.warehouse = warehouse.warehouse_id;
    const [uom1, uom2] = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    ids.uom1 = uom1.uom_id;
    ids.uom2 = uom2.uom_id;

    for (const [key, suffix] of [
      ['item1', 'IT1'],
      ['item2', 'IT2'],
    ] as const) {
      const item = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${suffix}`,
          item_name: `출하작업지시검사품목${suffix}`,
          item_type_code: 'FINISHED',
          base_uom_id: ids.uom1,
        },
      });
      ids[key] = item.item_id;
    }

    // ⭐ 배송처를 고객과 «다른» 파트너로 세운다 — 같으면 두 칸을 뒤바꿔도 안 잡힌다(§6-3 ⑵).
    for (const [key, suffix] of [
      ['customer', 'C1'],
      ['shipTo', 'SH1'],
      ['customer2', 'C2'],
      ['shipTo2', 'SH2'],
    ] as const) {
      const partner = await prisma.partner.create({
        data: { partner_code: `${PREFIX}-${suffix}`, partner_name: `출하작업지시검사파트너${suffix}` },
      });
      ids[key] = partner.partner_id;
    }

    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WK`,
        worker_name: '출하검사원',
        business_unit_id: unit.business_unit_id,
        plant_id: ids.plant,
        status_code: 'EMPLOYED',
      },
    });
    ids.worker = worker.worker_id;

    const salesOrder = await prisma.sales_order.create({
      data: {
        sales_order_no: `${PREFIX}-SO`,
        customer_id: ids.customer,
        ship_to_partner_id: ids.shipTo,
        order_date: new Date('2026-08-01T00:00:00.000Z'),
        status_code: 'RECEIVED',
        sales_order_line: {
          create: [{ line_no: 1, item_id: ids.item1, uom_id: ids.uom1, ordered_qty: 500 }],
        },
      },
    });
    ids.salesOrder = salesOrder.sales_order_id;
    ids.outsideLot = await makeLot('OUTSIDE');
  }

  async function makeLot(key: string): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-${key}`,
        item_id: ids.item1,
        lot_type_code: 'PRODUCT',
        plant_id: ids.plant,
        initial_qty: 1_000,
        uom_id: ids.uom1,
        source_type_code: 'WORK_ORDER',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    return lot.lot_id;
  }

  /** LOT 축 OQC — `target_id` 가 LOT 이고 `lot_id` 는 널이다(질의의 `target_id` 갈래를 죽인다). */
  async function makeOqc(
    targetTypeCode: string,
    targetId: bigint,
    lotId: bigint | null,
    results: OqcSpec[],
  ): Promise<void> {
    if (results.length === 0) return;
    const req = await prisma.inspection_request.create({
      data: {
        inspection_request_no: no('IRQ'),
        inspection_type_code: 'OQC',
        target_type_code: targetTypeCode,
        target_id: targetId,
        item_id: ids.item1,
        lot_id: lotId,
        target_qty: 10,
        uom_id: ids.uom1,
        status_code: 'COMPLETED',
        requested_at: new Date('2026-08-12T00:00:00.000Z'),
      },
    });
    for (const spec of results) {
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: no('IRS'),
          inspection_request_id: req.inspection_request_id,
          inspection_round: spec.round ?? 1,
          inspected_qty: 10,
          // `ck_inspection_result_qty` — 세 칸의 합이 검사 수량과 같아야 한다.
          accepted_qty: spec.judgment === 'ACCEPTED' ? 10 : 0,
          rejected_qty: spec.judgment === 'REJECTED' ? 10 : 0,
          held_qty: spec.judgment === 'HELD' ? 10 : 0,
          uom_id: ids.uom1,
          inspector_id: ids.worker,
          inspected_at: new Date('2026-08-12T01:00:00.000Z'),
          status_code: spec.status ?? 'CONFIRMED',
          overall_judgment_code: spec.judgment,
          idempotency_key: no('IRK'),
        },
      });
    }
  }

  async function makeRequest(key: string, spec: RequestSpec): Promise<Made> {
    const header = await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-${key}`,
        customer_id: spec.partner === 2 ? ids.customer2 : ids.customer,
        ship_to_partner_id: spec.partner === 2 ? ids.shipTo2 : ids.shipTo,
        requested_ship_date: new Date(`${spec.shipDate ?? '2026-08-14'}T00:00:00.000Z`),
        status_code: STORED_STATUS,
        ship_time_slot_code: spec.timeSlot ?? null,
        version_no: spec.versionNo ?? 1,
        sales_order_id: spec.salesOrder === true ? ids.salesOrder : null,
      },
    });

    const soLine = await prisma.sales_order_line.findFirstOrThrow({
      where: { sales_order_id: ids.salesOrder },
    });
    const lines: MadeLine[] = [];
    for (const [index, line] of spec.lines.entries()) {
      const created = await prisma.shipment_request_line.create({
        data: {
          shipment_request_id: header.shipment_request_id,
          line_no: index + 1,
          sales_order_line_id: line.salesOrderLine === true ? soLine.sales_order_line_id : null,
          item_id: line.item === 2 ? ids.item2 : ids.item1,
          uom_id: line.uom === 2 ? ids.uom2 : ids.uom1,
          requested_qty: line.requested,
          allocated_qty: line.allocated,
          shipped_qty: line.shipped ?? 0,
          customer_lot_requirement: line.lotRequirement ?? null,
          shipping_inspection_required: line.required ?? false,
          minimum_remaining_shelf_life_days: line.shelfLife ?? null,
        },
      });
      const lotA = await makeLot(`${key}-L${index + 1}A`);
      const lotB = await makeLot(`${key}-L${index + 1}B`);

      for (const pick of line.picks ?? []) {
        await prisma.inventory_reservation.create({
          data: {
            reservation_no: no('RS'),
            reservation_type_code: 'SHIPMENT',
            source_document_type_code: pick.typeCode ?? AXIS,
            source_document_id: created.shipment_request_line_id,
            item_id: line.item === 2 ? ids.item2 : ids.item1,
            lot_id: pick.noLot === true ? null : pick.lot === 'b' ? lotB : lotA,
            warehouse_id: ids.warehouse,
            reserved_qty: pick.reserved,
            released_qty: pick.released ?? 0,
            consumed_qty: pick.consumed ?? 0,
            uom_id: line.uom === 2 ? ids.uom2 : ids.uom1,
            status_code: pick.statusCode ?? 'REGISTERED',
          },
        });
      }

      await makeOqc('LOT', lotA, null, line.oqc ?? []);
      if (line.oqcSplit) await makeOqc('LOT', ids.outsideLot, lotA, [line.oqcSplit]);
      lines.push({
        id: Number(created.shipment_request_line_id),
        lotA: Number(lotA),
        lotB: Number(lotB),
        salesOrderLineId:
          line.salesOrderLine === true ? Number(soLine.sales_order_line_id) : null,
      });
    }

    for (const oqc of spec.headerOqc ?? []) {
      const lotId =
        oqc.lot === 'own' ? BigInt(lines[0].lotA) : oqc.lot === 'outside' ? ids.outsideLot : null;
      await makeOqc('SHIPMENT_REQUEST', header.shipment_request_id, lotId, [oqc]);
    }
    const record: Made = { id: Number(header.shipment_request_id), lines };
    made[key] = record;
    return record;
  }

  async function makeRequests(): Promise<void> {
    // 헤더 8칸 — 진행 PICKING · 검사 REJECTED 로 «서로 다른» 문자열이 나오게 세웠다.
    await makeRequest('HDR', {
      salesOrder: true,
      timeSlot: 'MORNING',
      versionNo: 5,
      shipDate: '2026-08-13',
      lines: [
        {
          requested: 100,
          allocated: 100,
          required: true,
          picks: [{ reserved: 40 }],
          oqc: [{ judgment: 'REJECTED' }],
        },
      ],
    });

    // 라인 10칸 + picks 5칸 — 열 칸의 값이 서로 다르고 라인 둘의 값도 갈린다.
    await makeRequest('LINE', {
      lines: [
        {
          requested: 120,
          allocated: 90,
          shipped: 30,
          required: true,
          uom: 2,
          salesOrderLine: true,
          lotRequirement: '고객 LOT 조건 1',
          shelfLife: 7,
          picks: [{ reserved: 60 }],
        },
        {
          requested: 240,
          allocated: 150,
          shipped: 45,
          item: 2,
          picks: [
            { reserved: 75, lot: 'a' },
            { reserved: 15, lot: 'b' },
          ],
        },
      ],
    });

    await makeRequest('NULLS', { lines: [{ requested: 10, allocated: 0 }] });

    // 롤업 — 해제분을 빼고, 소진분은 «안» 뺀다.
    await makeRequest('REL', {
      lines: [{ requested: 100, allocated: 30, picks: [{ reserved: 50, released: 20 }] }],
    });
    await makeRequest('CONS', {
      lines: [{ requested: 80, allocated: 80, picks: [{ reserved: 80, consumed: 80 }] }],
    });
    await makeRequest('MIX', {
      lines: [
        {
          requested: 100,
          allocated: 50,
          picks: [
            { reserved: 50 },
            { reserved: 70, typeCode: 'MATERIAL_ISSUE_REQUEST_LINE', lot: 'b' },
          ],
        },
      ],
    });
    // ⭐ 예약 축의 «가장자리» 둘 — `lot_id` 널 · 다른 `status_code`. 둘 다 값이 하나뿐이면
    //   그 축의 결정(널 행을 안 거른다 · 상태로 안 좁힌다)이 공허해진다(§6-3 ⑵).
    await makeRequest('EDGE', {
      lines: [
        {
          requested: 100,
          allocated: 60,
          picks: [
            { reserved: 10, lot: 'a' },
            { reserved: 20, noLot: true },
            { reserved: 30, lot: 'b', statusCode: 'CLOSED' },
          ],
        },
      ],
    });
    await makeRequest('DEC', {
      lines: [
        {
          requested: 1,
          allocated: 0.3,
          picks: [
            { reserved: 0.1, lot: 'a' },
            { reserved: 0.2, lot: 'b' },
          ],
        },
      ],
    });

    // 진행 6값.
    await makeRequest('PROG_A', {
      lines: [{ requested: 100, allocated: 100, picks: [{ reserved: 40 }] }],
    });
    await makeRequest('PROG_B', {
      lines: [{ requested: 100, allocated: 60, picks: [{ reserved: 30 }] }],
    });
    await makeRequest('PROG_B2', {
      lines: [{ requested: 100, allocated: 60, picks: [{ reserved: 60 }] }],
    });
    await makeRequest('PROG_D', {
      lines: [{ requested: 100, allocated: 100, shipped: 40, picks: [{ reserved: 100 }] }],
    });
    await makeRequest('PROG_E', {
      lines: [{ requested: 100, allocated: 100, shipped: 100, picks: [{ reserved: 100 }] }],
    });
    await makeRequest('PROG_F', { lines: [{ requested: 100, allocated: 0 }] });

    // 검사 5값 — 라인 값을 섞어 우선순위 다섯 자리를 전부 겨눈다.
    const passed = (): LineSpec => ({
      requested: 10,
      allocated: 10,
      required: true,
      picks: [{ reserved: 10 }],
      oqc: [{ judgment: 'ACCEPTED' }],
    });
    const pending = (): LineSpec => ({
      requested: 10,
      allocated: 10,
      required: true,
      picks: [{ reserved: 10 }],
    });
    const notRequired = (): LineSpec => ({ requested: 10, allocated: 10 });
    const held = (): LineSpec => ({ ...passed(), oqc: [{ judgment: 'HELD' }] });
    const rejected = (): LineSpec => ({ ...passed(), oqc: [{ judgment: 'REJECTED' }] });

    await makeRequest('INS_NR', { lines: [notRequired()] });
    await makeRequest('INS_PASS', { lines: [notRequired(), passed()] });
    await makeRequest('INS_PEND', { lines: [notRequired(), pending(), passed()] });
    await makeRequest('INS_HELD', { lines: [passed(), pending(), held()] });
    await makeRequest('INS_REJ', { lines: [passed(), pending(), held(), rejected()] });

    await makeRequest('INS_DRAFT', {
      lines: [{ ...passed(), oqc: [{ judgment: 'ACCEPTED', status: 'DRAFT' }] }],
    });
    await makeRequest('INS_ROUND', {
      lines: [
        {
          ...passed(),
          oqc: [
            { judgment: 'REJECTED', round: 1 },
            { judgment: 'ACCEPTED', round: 2 },
          ],
        },
      ],
    });
    // 라인 둘 다 LOT 축 결과가 0건이다 — 헤더 대상 하나가 둘을 물들여야 PASSED 가 된다.
    await makeRequest('INS_HDR', {
      lines: [pending(), pending()],
      headerOqc: [{ judgment: 'ACCEPTED' }],
    });
    await makeRequest('INS_HDRLOT', {
      lines: [pending()],
      headerOqc: [{ judgment: 'ACCEPTED', lot: 'outside' }],
    });
    await makeRequest('INS_SPLIT', {
      lines: [{ ...pending(), oqcSplit: { judgment: 'REJECTED' } }],
    });

    // ── 목록·요약(PR ④) 전용 축 ─────────────────────────────────────────────
    // ⭐ `SR-G` — 라인 «0건». L-9(공허참)와 R-9(「lines 를 늘 싣는다」)를 같은 픽스처로 잠근다.
    //   컬렉션 길이 축이 1·2·3·4 뿐이면 「라인 0건이면 lines 키 생략」 변이가 초록이다(§6-3 ⑵).
    await makeRequest('SR_G', { lines: [] });
    // 피킹 완료 / 한 라인만 미달 — 정량자 「전체」를 판다.
    await makeRequest('FULL', {
      lines: [
        { requested: 10, allocated: 10, picks: [{ reserved: 10 }] },
        { requested: 10, allocated: 10, picks: [{ reserved: 10 }] },
      ],
    });
    await makeRequest('PART', {
      lines: [
        { requested: 10, allocated: 10, picks: [{ reserved: 10 }] },
        { requested: 10, allocated: 10, picks: [{ reserved: 4 }] },
      ],
    });
    // ⭐ 해제분을 빼야 «미달»이 되는 라인 — `- released_qty` 를 빼면 50 ≥ 50 이라 완료로 샌다.
    await makeRequest('RELPART', {
      lines: [{ requested: 100, allocated: 50, picks: [{ reserved: 50, released: 20 }] }],
    });
    // 출하 잔여 — 한 라인만 남았다(정량자가 위와 반대다).
    await makeRequest('REM', {
      lines: [
        { requested: 10, allocated: 10, shipped: 10, picks: [{ reserved: 10 }] },
        { requested: 10, allocated: 10, shipped: 4, picks: [{ reserved: 10 }] },
      ],
    });
    // ⭐ 같은 품목 라인 «둘» — `itemId` 를 조인으로 걸면 이 헤더가 두 번 나오고 total 이 부푼다.
    await makeRequest('DUP', {
      lines: [
        { requested: 5, allocated: 5, item: 2 },
        { requested: 5, allocated: 5, item: 2 },
      ],
    });
    // 고객·배송처 필터의 「안 걸리는 행」 · 시간대 셋째 값 · 기간 바깥.
    await makeRequest('CUST2', { partner: 2, lines: [{ requested: 10, allocated: 10 }] });
    await makeRequest('TSPM', { timeSlot: 'AFTERNOON', lines: [{ requested: 10, allocated: 10 }] });
    await makeRequest('OUT', { shipDate: '2026-08-20', lines: [{ requested: 10, allocated: 10 }] });
  }

  async function makeUser(): Promise<void> {
    // 계약이 403 을 선언하지 않은 조회다 — 권한 없이 세션만 있으면 된다.
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출하작업지시검사', status_code: 'EMPLOYED' },
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
      `DELETE FROM quality.inspection_result WHERE inspection_result_no LIKE '${PREFIX}%'`,
      `DELETE FROM quality.inspection_request WHERE inspection_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.inventory_reservation WHERE reservation_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request
          WHERE shipment_request_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.sales_order_line WHERE sales_order_id IN (
         SELECT sales_order_id FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});
