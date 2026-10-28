/**
 * 입하 등록 — 화면 `M-01-01`. 「입하·라인·자재 LOT 이 한 트랜잭션으로 만들어진다」(계약).
 *
 * ⚠ 픽스처는 전부 «직접 INSERT» 다 — ASN·P/O 라인·입하 라인을 만드는 등록 경로를 이
 * 스위트가 쓰지 않기 위해서다(P/O 는 동시성 검사 하나에서만 API 로 만든다).
 * ⚠ 정리 순서 — `inbound_receipt_line` 이 `trace.lot` 을 «가리키므로» LOT 보다 먼저 지운다
 * (I-3.md §6-5 · P/O e2e 에는 없던 순서).
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

const LOGIN_ID = 'e2e-ir-probe';
const NOPERM_ID = 'e2e-ir-noperm';
/** 웹 입하 등록 화면(W-01-03) 권한만 가진 사무실 사용자 — `:per-line` 이 웹 입고 관리에서도 불린다(장부 P-117). */
const WEB_ID = 'e2e-ir-web';
const WEB_ROLE = 'E2E_IR_WEB';
const PASSWORD = '입하-등록-검사-비밀번호';
const PREFIX = 'IRE2E';
/**
 * 자재 MES LOT 번호(`materialMesLotNo`)는 구분자 5칸 형식이라(통보 277) 품목·공급사 코드를
 * **원본 그대로** 담는다 — 실 하노이 품목 코드 모양(하이픈 포함)을 그대로 쓴다. 옛 34자리
 * 전부-숫자 형식은 이런 코드를 전부 거절했다(#620) — 여기 값이 그 형식을 통과하는 것 자체가
 * #620 회귀 확인이다.
 *
 * ⚠ `item_code`/`partner_code` 는 마스터에 유일 제약이 있다 — 다른 e2e 파일(`trace-lot`·
 * `logistics-document-progress`)과 값이 겹치면 병렬 실행에서 충돌한다. 파일마다 접미어를 다르게 둔다.
 */
const ITEM_CODE = '040101-00023S';
const SUPPLIER_CODE = '100020';
const ROLE = 'E2E_IR';
/** `W-01-11` 은 동시성 검사 하나가 P/O 라인 치환을 함께 걸기 위해서다. */
const PERMISSIONS = ['M-01-01', 'W-01-11', 'W-01-03', 'M-01-06'];
const BUSINESS_DATE = '2026-08-06';
const RECEIPT_AT = '2026-08-06T09:12:00+09:00';

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

interface ReceiptBody {
  inboundReceiptId: number;
  inboundReceiptNo: string;
  statusCode: string;
  receivedBy: number | null;
  exceptionTypeCode: string | null;
}
interface LineBody {
  inboundReceiptLineId: number;
  lineNo: number;
  purchaseOrderLineId: number | null;
  receivedQty: number;
  supplierLotNo: string | null;
  supplierLotMissing: boolean;
  substituteLotReasonCode: string | null;
  inspectionRequired: boolean;
  statusCode: string;
  lotId: number | null;
}
interface Detail {
  inboundReceipt: ReceiptBody;
  lines: LineBody[];
}
interface LineDraft {
  inboundReceiptLineId?: number;
  purchaseOrderLineId?: number | null;
  itemId: number;
  receivedQty: number;
  uomId: number;
  supplierLotNo?: string | null;
  supplierLotMissing: boolean;
  substituteLotReasonCode?: string | null;
  manufacturedDate?: string | null;
  expiryDate?: string | null;
}

describe('입하 등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let webCookie: string[];

  let supplierId: number;
  let businessUnitId: number;
  let plantId: number;
  let itemId: number;
  let uomId: number;
  let warehouseId: number;
  let dockId: number;
  let lotSeq = 0;
  let orderSeq = 0;
  let receiptSeq = 0;

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

  it('입하 — 등록 응답이 계약 InboundReceiptDetailResponse 를 만족한다', async () => {
    const detail = await create();

    const validate = validator('POST /logistics/inbound-receipts', 201);
    expect(validate(detail)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('입하 — 등록이 헤더·라인·LOT 을 한 트랜잭션으로 만든다(라인 실패면 헤더도 LOT 도 없다)', async () => {
    const before = await prisma.inbound_receipt.count({ where: { plant_id: plantId } });
    const lotsBefore = await prisma.lot.count({ where: { plant_id: plantId } });

    await send(
      await body({
        lines: [
          await lineDraft(),
          // 없는 uom — 라인 삽입이 FK 위반으로 실패해 트랜잭션 전체가 롤백돼야 한다.
          { ...(await lineDraft()), uomId: 999999999 },
        ],
      }),
    ).expect(400);

    expect(await prisma.inbound_receipt.count({ where: { plant_id: plantId } })).toBe(before);
    expect(await prisma.lot.count({ where: { plant_id: plantId } })).toBe(lotsBefore);
  });

  it('입하 — 입하번호는 서버가 짓는다(IR-YYYYMMDD-\\d{4,})', async () => {
    const detail = await create();

    expect(detail.inboundReceipt.inboundReceiptNo).toMatch(/^IR-20260806-\d{4,}$/);
  });

  it('입하 — 상태는 서버가 REGISTERED 로 정한다(본문이 statusCode 를 받지 않는다)', async () => {
    const created = await send({ ...(await body()), statusCode: 'POSTED' } as object).expect(201);

    const detail = created.body as Detail;
    expect(detail.inboundReceipt.statusCode).toBe('REGISTERED');
    expect(detail.lines[0].statusCode).toBe('REGISTERED');
  });

  it('입하 — lines 가 빈 배열이면 400 LINE_REQUIRED 다', async () => {
    const rejected = await send(await body({ lines: [] })).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('입하 — supplierLotMissing=true 인데 substituteLotReasonCode 가 없으면 400 이다', async () => {
    const draft = await lineDraft();
    const rejected = await send(
      await body({
        lines: [{ ...draft, supplierLotNo: null, supplierLotMissing: true }],
      }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lines.0.substituteLotReasonCode',
      code: 'PAIR',
    });
  });

  it('입하 — exceptionTypeCode 만 있고 exceptionReason 이 없으면 400 PAIR 다', async () => {
    const rejected = await send(
      await body({ exceptionTypeCode: 'CUSTOMER_SUPPLY', exceptionReason: undefined }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'exceptionReason', code: 'PAIR' });
  });

  it('입하 — expiryDate 가 manufacturedDate 보다 앞서면 400 이다(ck_inbound_expiry 가 500 으로 새지 않는다)', async () => {
    const draft = await lineDraft();
    const rejected = await send(
      await body({
        lines: [{ ...draft, manufacturedDate: '2026-08-06', expiryDate: '2026-08-05' }],
      }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'lines.0.expiryDate', code: 'INVALID' });
  });

  it('입하 — 사전부착 라인의 lotId 가 응답에 채워진다', async () => {
    const supplierLotNo = supplierLotNoOf((lotSeq += 1));
    const detail = await create({ lines: [{ ...(await lineDraft()), supplierLotNo }] });

    const lotId = detail.lines[0].lotId;
    expect(lotId).not.toBeNull();
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId as number) } });
    expect(lot.lot_no).toBe(supplierLotNo);
    expect(lot.lot_type_code).toBe('MATERIAL');
    expect(lot.manufactured_at).toBeNull();
    expect(await prisma.lot_hold.count({ where: { lot_id: lot.lot_id } })).toBe(1);
  });

  it('입하 — 미부착 라인의 lotId 는 널이다(키를 생략하지 않는다)', async () => {
    const draft = await lineDraft();
    const detail = await create({
      lines: [
        {
          ...draft,
          supplierLotNo: null,
          supplierLotMissing: true,
          substituteLotReasonCode: 'NO_LABEL',
        },
      ],
    });

    expect(detail.lines[0]).toHaveProperty('lotId');
    expect(detail.lines[0].lotId).toBeNull();
  });

  it('입하 — purchase_order_line.received_qty 가 라인 수량만큼 오른다', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);

    await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 30 }] });

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(30);
  });

  it('입하 — 발주+허용치를 넘기면 400 QTY_EXCEEDS_ORDERED 다(ck_po_line_received 가 500 으로 새지 않는다)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(10, 2);

    const rejected = await send(
      await body({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 13 }] }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lines.0.receivedQty',
      code: 'QTY_EXCEEDS_ORDERED',
    });
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
  });

  it('입하 — 같은 P/O 에 두 번 등록하면 received_qty 가 누적된다(분할 납품)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);

    await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 40 }] });
    await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 25 }] });

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(65);
  });

  // 발주 5,000 — 500 을 먼저 받고, 공급사 포장 사정으로 라벨 한 장 5,000 이 더 왔다. 그 LOT 이 IQC 한 단위라
  // 줄 하나로 받고, 남은 4,500 만 P/O 에 넣고 500 은 ERP 추가 P/O 를 기다리는 초과분으로 남긴다(장부 P-100).
  describe('초과분 — 한 LOT 의 일부만 P/O 에 넣는다', () => {
    it('초과분 — 줄·LOT 은 5,000 그대로이고 P/O 에는 4,500 만 오르며 초과분 500 이 안 이어진 채 남는다', async () => {
      const { purchaseOrderLineId } = await seedOrderLine(5000);
      await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 500 }] });

      const detail = await create({
        lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 5000, excessQty: 500 }],
      });

      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(5000);
      const line = detail.lines[0] as LineBody & { excessQty: number; excesses: object[] };
      expect(line.receivedQty).toBe(5000);
      expect(line.excessQty).toBe(500);
      expect(line.excesses).toEqual([expect.objectContaining({ excessQty: 500, purchaseOrderLineId: null, linkedAt: null })]);
      const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(line.lotId as number) } });
      expect(Number(lot.initial_qty)).toBe(5000);
      // 배정 표(이중 쓰기) — 줄의 P/O 몫 4,500 하나. 초과분 500 은 미배정이라 행이 없다.
      expect(await allocationsOf(line.inboundReceiptLineId)).toEqual([[purchaseOrderLineId, 4500]]);
    });

    it('초과분 — 줄 전체가 초과분이어도 된다: P/O 에는 0 이 오르고 배정 없이 전부 미배정으로 남는다', async () => {
      const { purchaseOrderLineId } = await seedOrderLine(100);

      const detail = await create({
        lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 1000, excessQty: 1000 }],
      });

      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
      const line = detail.lines[0] as LineBody & { excessQty: number; excesses: object[] };
      expect(line.excessQty).toBe(1000);
      expect(line.excesses).toEqual([expect.objectContaining({ excessQty: 1000, purchaseOrderLineId: null })]);
      expect(await allocationsOf(line.inboundReceiptLineId)).toEqual([]);
      const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(line.lotId as number) } });
      expect(Number(lot.initial_qty)).toBe(1000);
    });

    it('초과분 — 칸이 틀리면 400 이 그 칸을 짚고 아무것도 남지 않는다', async () => {
      const { purchaseOrderLineId } = await seedOrderLine(100);
      const before = await prisma.inbound_receipt_excess.count();
      const allocationsBefore = await prisma.inbound_receipt_po_allocation.count();

      const rejected = await send(
        await body({
          lines: [
            { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 50, excessQty: '5' },
            { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 50, excessQty: 51 },
          ],
        }),
      ).expect(400);

      expect(rejected.body.errors).toEqual([
        expect.objectContaining({ field: 'lines.0.excessQty', code: 'INVALID' }),
        expect.objectContaining({ field: 'lines.1.excessQty', code: 'RANGE' }),
      ]);
      expect(await prisma.inbound_receipt_excess.count()).toBe(before);
      expect(await prisma.inbound_receipt_po_allocation.count()).toBe(allocationsBefore);
      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
    });

    it('초과분 — 무발주 줄에는 초과분을 쓸 수 없다(400 INVALID)', async () => {
      const rejected = await send(
        await body({
          exceptionTypeCode: 'CUSTOMER_SUPPLY',
          exceptionReason: '고객사급 자재',
          lines: [{ ...(await lineDraft()), purchaseOrderLineId: null, excessQty: 1 }],
        }),
      ).expect(400);

      expect(rejected.body.errors).toEqual([expect.objectContaining({ field: 'lines.0.excessQty', code: 'INVALID' })]);
    });

    it('초과분 — 라인 치환이 초과분을 바꾸면 P/O 에 넣은 몫과 초과분 기록이 함께 바뀐다', async () => {
      const { purchaseOrderLineId } = await seedOrderLine(100);
      const detail = await create({
        lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 120, excessQty: 20 }],
      });
      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(100);

      const items = await replace(detail.inboundReceipt.inboundReceiptId, [itemOf(detail.lines[0], { excessQty: 30 })]);

      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(90);
      expect((items[0] as LineBody & { excessQty: number }).excessQty).toBe(30);
      const rows = await prisma.inbound_receipt_excess.findMany({
        where: { inbound_receipt_line_id: BigInt(detail.lines[0].inboundReceiptLineId) },
      });
      expect(rows.map((row) => Number(row.excess_qty))).toEqual([30]);
      // 배정도 다시 적힌다 — 몫 120 − 30.
      expect(await allocationsOf(detail.lines[0].inboundReceiptLineId)).toEqual([[purchaseOrderLineId, 90]]);
    });

    it('배정 — LOT 이 만들어진 줄은 치환으로 받은 수량을 바꾸지 못한다(수량 정정으로) · P/O 받은 수량과 배정이 그대로다', async () => {
      const { purchaseOrderLineId } = await seedOrderLine(100);
      const detail = await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 60 }] });
      expect(await allocationsOf(detail.lines[0].inboundReceiptLineId)).toEqual([[purchaseOrderLineId, 60]]);
      expect(detail.lines[0].lotId).toEqual(expect.any(Number));

      const etag = await receiptEtag(detail.inboundReceipt.inboundReceiptId);
      const rejected = await putLines(detail.inboundReceipt.inboundReceiptId, etag, [itemOf(detail.lines[0], { receivedQty: 70 })]).expect(400);

      expect(rejected.body.errors[0]).toMatchObject({ field: 'items.0.receivedQty', code: 'STATE_LOCKED' });
      expect(rejected.body.errors[0].message).toContain('LOT 수량 정정');
      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(60);
      expect(await allocationsOf(detail.lines[0].inboundReceiptLineId)).toEqual([[purchaseOrderLineId, 60]]);
    });
  });

  // 입하 줄 ↔ P/O 라인 배정 경로 — 미배정으로 남긴 몫을 나중에 온 P/O 에 잇는다(사용자 결정 2026-10-24 · 초과분 잇기를 대신한다).
  describe('배정 경로', () => {
    const api = (path: string, method: 'get' | 'post' | 'delete' = 'get', as = cookie): request.Test =>
      request(app.getHttpServer())[method](`/api/logistics${path}`).set('Cookie', as);
    const detailOf = async (inboundReceiptId: number): Promise<Detail> =>
      (await request(app.getHttpServer()).get(`/api/logistics/inbound-receipts/${inboundReceiptId}`).set('Cookie', cookie).expect(200)).body as Detail;
    type AllocatedLine = LineBody & { unallocatedQty: number; allocations: { purchaseOrderLineId: number; allocatedQty: number }[] };

    /** 발주 `ordered` 에 `allocated` 만 넣고 `excess` 를 미배정으로 남긴 줄 하나. */
    async function unallocatedOf(ordered: number, allocated: number, excess: number) {
      const source = await seedOrderLine(ordered);
      const detail = await create({
        lines: [{ ...(await lineDraft()), purchaseOrderLineId: source.purchaseOrderLineId, receivedQty: allocated + excess, excessQty: excess }],
      });
      return { source, detail, lineId: detail.lines[0].inboundReceiptLineId };
    }

    it('목록·후보 — 미배정이 남은 줄이 배정과 함께 보이고, 후보는 딱 맞는 라인 먼저이며 줄 자신의 P/O 라인도 들어간다', async () => {
      // 발주 5,000 에 4,500 만 넣었다 — 남은 500 이 있어 자신의 라인도 300 을 더 받을 수 있다.
      const { source, lineId } = await unallocatedOf(5000, 4500, 300);
      const exact = await seedOrderLine(300);
      const roomy = await seedOrderLine(1000);
      const small = await seedOrderLine(200);

      const list = await api('/inbound-unallocated?size=200').expect(200);
      const row = (list.body.items as { inboundReceiptLineId: number }[]).find((item) => item.inboundReceiptLineId === lineId);
      expect(row).toMatchObject({
        receivedQty: 4800,
        unallocatedQty: 300,
        allocations: [
          expect.objectContaining({
            allocatedQty: 4500,
            orderLine: expect.objectContaining({ purchaseOrderLineId: source.purchaseOrderLineId }),
          }),
        ],
      });
      // 이 파일의 기본 입하는 예외 유형을 싣는다 — 행이 그 유형을 그대로 낸다(화면이 가릴 수 있게).
      expect(typeof (row as unknown as { exceptionTypeCode: unknown }).exceptionTypeCode).toBe('string');

      const candidates = await api(`/inbound-receipt-lines/${lineId}/allocation-candidates`).expect(200);
      const ids = (candidates.body.items as { purchaseOrderLineId: number }[]).map((item) => item.purchaseOrderLineId);
      expect(ids).toContain(source.purchaseOrderLineId);
      expect(ids).not.toContain(small.purchaseOrderLineId);
      expect(ids.indexOf(exact.purchaseOrderLineId)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(exact.purchaseOrderLineId)).toBeLessThan(ids.indexOf(roomy.purchaseOrderLineId));
    });

    it('더하기 — 새 P/O 라인의 received_qty 가 오르고 줄의 allocations·unallocatedQty 가 바뀌며 목록에서 빠진다 · 미배정을 넘으면 400 RANGE', async () => {
      const { detail, lineId } = await unallocatedOf(5000, 5000, 500);
      const added = await seedOrderLine(500);

      const created = await api(`/inbound-receipt-lines/${lineId}/allocations`, 'post')
        .send({ purchaseOrderLineId: added.purchaseOrderLineId, qty: 500 })
        .expect(201);

      expect(created.body).toMatchObject({ inboundReceiptLineId: lineId, allocatedQty: 500, orderLine: { purchaseOrderLineId: added.purchaseOrderLineId } });
      expect(Number((await poLine(added.purchaseOrderLineId)).received_qty)).toBe(500);
      const line = (await detailOf(detail.inboundReceipt.inboundReceiptId)).lines[0] as AllocatedLine;
      expect(line.unallocatedQty).toBe(0);
      expect(line.allocations.map((row) => [row.purchaseOrderLineId, row.allocatedQty])).toEqual([
        [detail.lines[0].purchaseOrderLineId, 5000],
        [added.purchaseOrderLineId, 500],
      ]);
      const listed = ((await api('/inbound-unallocated?size=200').expect(200)).body.items as { inboundReceiptLineId: number }[]).map((item) => item.inboundReceiptLineId);
      expect(listed).not.toContain(lineId);
      const over = await api(`/inbound-receipt-lines/${lineId}/allocations`, 'post').send({ purchaseOrderLineId: added.purchaseOrderLineId, qty: 1 }).expect(400);
      expect(over.body.errors[0]).toMatchObject({ field: 'qty', code: 'RANGE' });
    });

    it('빼기 — received_qty 가 되돌아가고 미배정으로 돌아간다 · 없는 배정은 404 · 본문이 틀리면 400 이 칸을 짚는다', async () => {
      const { lineId } = await unallocatedOf(5000, 5000, 500);
      const added = await seedOrderLine(500);
      const created = await api(`/inbound-receipt-lines/${lineId}/allocations`, 'post').send({ purchaseOrderLineId: added.purchaseOrderLineId, qty: 500 }).expect(201);
      const allocationId = created.body.inboundReceiptPoAllocationId as number;

      await api(`/inbound-receipt-lines/${lineId}/allocations/${allocationId}`, 'delete').expect(204);

      expect(Number((await poLine(added.purchaseOrderLineId)).received_qty)).toBe(0);
      expect(await allocationsOf(lineId)).toHaveLength(1);
      await api(`/inbound-receipt-lines/${lineId}/allocations/${allocationId}`, 'delete').expect(404);
      const bad = await api(`/inbound-receipt-lines/${lineId}/allocations`, 'post').send({ qty: 'x' }).expect(400);
      expect(bad.body.errors).toEqual([
        expect.objectContaining({ field: 'purchaseOrderLineId', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'qty', code: 'INVALID' }),
      ]);
    });

    it('전부 미배정으로 받은 줄을 새 P/O 에 통째로 잇는다 — 처음 P/O 에는 아무것도 남지 않는다', async () => {
      const { source, lineId } = await unallocatedOf(100, 0, 1000);
      const added = await seedOrderLine(1000);

      await api(`/inbound-receipt-lines/${lineId}/allocations`, 'post').send({ purchaseOrderLineId: added.purchaseOrderLineId, qty: 1000 }).expect(201);

      expect(Number((await poLine(added.purchaseOrderLineId)).received_qty)).toBe(1000);
      expect(Number((await poLine(source.purchaseOrderLineId)).received_qty)).toBe(0);
      expect(await allocationsOf(lineId)).toEqual([[added.purchaseOrderLineId, 1000]]);
    });

    it('excludeExceptionTypeCode — 그 유형의 입하 줄이 빠지고 예외 없는 줄은 남는다 · page.total 도 뺀 수', async () => {
      const lineOf = async (exceptionTypeCode: string | null): Promise<number> => {
        const source = await seedOrderLine(100);
        const detail = await create({
          exceptionTypeCode,
          exceptionReason: exceptionTypeCode === null ? null : '시험',
          lines: [{ ...(await lineDraft()), purchaseOrderLineId: source.purchaseOrderLineId, receivedQty: 110, excessQty: 10 }],
        });
        return detail.lines[0].inboundReceiptLineId;
      };
      const [customer, sample, over, plain] = [await lineOf('CUSTOMER_SUPPLY'), await lineOf('FREE_SAMPLE'), await lineOf('OVER_DELIVERY'), await lineOf(null)];
      type Row = { inboundReceiptLineId: number; exceptionTypeCode: string | null };
      const listOf = async (extra: string) => {
        const body = (await api(`/inbound-unallocated?size=200&supplierId=${supplierId}${extra}`).expect(200)).body as { items: Row[]; page: { total: number } };
        return { ids: body.items.map((row) => row.inboundReceiptLineId), types: body.items.map((row) => row.exceptionTypeCode), total: body.page.total };
      };

      const all = await listOf('');
      const kept = await listOf('&excludeExceptionTypeCode=CUSTOMER_SUPPLY,FREE_SAMPLE');
      const repeated = await listOf('&excludeExceptionTypeCode=CUSTOMER_SUPPLY&excludeExceptionTypeCode=FREE_SAMPLE');

      expect(all.ids).toEqual(expect.arrayContaining([customer, sample, over, plain]));
      expect(kept.ids).toEqual(expect.arrayContaining([over, plain]));
      expect(kept.ids).not.toContain(customer);
      expect(kept.ids).not.toContain(sample);
      expect(kept.types).not.toContain('CUSTOMER_SUPPLY');
      expect(kept.total).toBe(all.total - all.types.filter((type) => type === 'CUSTOMER_SUPPLY' || type === 'FREE_SAMPLE').length);
      expect(repeated).toEqual(kept);
    });

    it('⛔ excludeExceptionTypeCode 가 비었거나 코드 모양이 아니면 400', async () => {
      for (const bad of ['', 'customer_supply', 'CUSTOMER_SUPPLY,']) {
        const response = await api(`/inbound-unallocated?excludeExceptionTypeCode=${bad}`).expect(400);
        expect(response.body.errors).toEqual([expect.objectContaining({ field: 'excludeExceptionTypeCode', code: 'INVALID' })]);
      }
    });

    it('권한 — 로그인 없으면 401, 화면 권한이 없으면 403', async () => {
      await request(app.getHttpServer()).get('/api/logistics/inbound-unallocated').expect(401);
      await api('/inbound-unallocated', 'get', noPermCookie).expect(403);
    });
  });

  // ERP 가 초과분으로 만든 추가 P/O 라인에 초과분을 잇는다 — 서버가 후보를 주고 사람이 고른다(장부 P-100).
  describe('초과분 잇기', () => {
    const excessApi = (path: string, method: 'get' | 'post' = 'get', as = cookie): request.Test =>
      request(app.getHttpServer())[method](`/api/logistics/inbound-excesses${path}`).set('Cookie', as);

    /** 발주 A 에서 받은 수량을 다 채우고 초과분 `excess` 를 남긴 줄 하나. */
    async function excessOf(ordered: number, excess: number) {
      const source = await seedOrderLine(ordered);
      const detail = await create({
        lines: [{ ...(await lineDraft()), purchaseOrderLineId: source.purchaseOrderLineId, receivedQty: ordered + excess, excessQty: excess }],
      });
      const line = detail.lines[0] as LineBody & { excesses: { inboundReceiptExcessId: number }[] };
      return { source, detail, excessId: line.excesses[0].inboundReceiptExcessId };
    }

    it('후보 — 남은 수량이 딱 맞는 라인이 먼저이고, 다 못 받는 라인과 초과분이 나온 라인은 빠진다', async () => {
      const { source, excessId } = await excessOf(5000, 500);
      const exact = await seedOrderLine(500);
      const roomy = await seedOrderLine(1000);
      const small = await seedOrderLine(300);

      const response = await excessApi(`/${excessId}/candidates`).expect(200);

      const ids = (response.body.items as { purchaseOrderLineId: number; exactMatch: boolean }[]).map((row) => row.purchaseOrderLineId);
      expect(ids.indexOf(exact.purchaseOrderLineId)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(exact.purchaseOrderLineId)).toBeLessThan(ids.indexOf(roomy.purchaseOrderLineId));
      expect(ids).not.toContain(small.purchaseOrderLineId);
      expect(ids).not.toContain(source.purchaseOrderLineId);
    });

    it('잇기 — 고른 P/O 라인의 받은 수량이 초과분만큼 오르고 목록이 안 이어진 쪽에서 이어진 쪽으로 옮겨 간다', async () => {
      const { excessId } = await excessOf(5000, 500);
      const added = await seedOrderLine(500);
      const unlinked = async (linked: boolean) =>
        ((await excessApi(`?linked=${linked}&size=200`).expect(200)).body.items as { inboundReceiptExcessId: number }[]).map(
          (row) => row.inboundReceiptExcessId,
        );
      expect(await unlinked(false)).toContain(excessId);

      const linked = await excessApi(`/${excessId}:link`, 'post').send({ purchaseOrderLineId: added.purchaseOrderLineId }).expect(200);

      expect(linked.body).toMatchObject({ excessQty: 500, linkedOrderLine: { purchaseOrderLineId: added.purchaseOrderLineId } });
      expect(Number((await poLine(added.purchaseOrderLineId)).received_qty)).toBe(500);
      expect(await unlinked(false)).not.toContain(excessId);
      expect(await unlinked(true)).toContain(excessId);
      const again = await excessApi(`/${excessId}:link`, 'post').send({ purchaseOrderLineId: added.purchaseOrderLineId }).expect(400);
      expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('잇기 — 다 못 받는 라인은 400 QTY_EXCEEDS_ORDERED, 초과분이 나온 라인은 400 INVALID 다', async () => {
      const { source, excessId } = await excessOf(5000, 500);
      const small = await seedOrderLine(300);

      const tooSmall = await excessApi(`/${excessId}:link`, 'post').send({ purchaseOrderLineId: small.purchaseOrderLineId }).expect(400);
      const own = await excessApi(`/${excessId}:link`, 'post').send({ purchaseOrderLineId: source.purchaseOrderLineId }).expect(400);

      expect(tooSmall.body.errors[0]).toMatchObject({ field: 'purchaseOrderLineId', code: 'QTY_EXCEEDS_ORDERED' });
      expect(own.body.errors[0]).toMatchObject({ field: 'purchaseOrderLineId', code: 'INVALID' });
      expect(Number((await poLine(small.purchaseOrderLineId)).received_qty)).toBe(0);
    });

    it('풀기 — 받은 수량이 되돌아가고 안 이어진 초과분으로 돌아간다 · 안 이어진 것을 풀면 400 STATE_LOCKED', async () => {
      const { excessId } = await excessOf(5000, 500);
      const added = await seedOrderLine(500);
      await excessApi(`/${excessId}:link`, 'post').send({ purchaseOrderLineId: added.purchaseOrderLineId }).expect(200);

      const unlinked = await excessApi(`/${excessId}:unlink`, 'post').expect(200);

      expect(unlinked.body).toMatchObject({ linkedOrderLine: null, linkedAt: null });
      expect(Number((await poLine(added.purchaseOrderLineId)).received_qty)).toBe(0);
      const again = await excessApi(`/${excessId}:unlink`, 'post').expect(400);
      expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('잇기 — 이어진 초과분이 있으면 그 입하 줄도, 이어진 P/O 라인도 바꾸거나 지울 수 없다(400 SUCCESSOR_EXISTS)', async () => {
      const { detail, excessId } = await excessOf(100, 20);
      const order = await createOrder();
      await excessApi(`/${excessId}:link`, 'post').send({ purchaseOrderLineId: order.lines[0].purchaseOrderLineId }).expect(200);

      const receiptLine = await putLines(detail.inboundReceipt.inboundReceiptId, await receiptEtag(detail.inboundReceipt.inboundReceiptId), [
        itemOf(detail.lines[0], { excessQty: 10 }),
      ]).expect(400);
      const orderLine = await request(app.getHttpServer())
        .put(`/api/logistics/purchase-orders/${order.purchaseOrder.purchaseOrderId}/lines`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .set('If-Match', await orderEtag(order.purchaseOrder.purchaseOrderId))
        .send({ items: [{ itemId, orderedQty: 100, uomId }] })
        .expect(400);

      expect(receiptLine.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
      expect(orderLine.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
    });

    it('목록 — 안 이어진 초과분이 입하·줄·처음 P/O 라인·품목·LOT 과 함께 보인다', async () => {
      const { source, detail, excessId } = await excessOf(5000, 500);

      const response = await excessApi('?linked=false&size=200').expect(200);

      const row = (response.body.items as { inboundReceiptExcessId: number }[]).find((item) => item.inboundReceiptExcessId === excessId);
      expect(row).toMatchObject({
        excessQty: 500,
        linkedOrderLine: null,
        inboundReceiptId: detail.inboundReceipt.inboundReceiptId,
        receivedQty: 5500,
        sourceOrderLine: { purchaseOrderLineId: source.purchaseOrderLineId },
        itemCode: ITEM_CODE,
        lotId: detail.lines[0].lotId,
      });
      const linked = await excessApi('?linked=true&size=200').expect(200);
      expect((linked.body.items as { inboundReceiptExcessId: number }[]).map((item) => item.inboundReceiptExcessId)).not.toContain(excessId);
    });

    it('권한 — 로그인 없으면 401, W-01-03 권한이 없으면 403 이다', async () => {
      await request(app.getHttpServer()).get('/api/logistics/inbound-excesses').expect(401);
      await excessApi('', 'get', noPermCookie).expect(403);
      await excessApi('/1:link', 'post', noPermCookie).send({ purchaseOrderLineId: 1 }).expect(403);
    });

    it('검사 — 틀린 질의·본문은 400 이 그 칸을 짚고, 없는 초과분은 404 다', async () => {
      const query = await excessApi('?linked=yes&plantId=0').expect(400);
      const bodyless = await excessApi('/1:link', 'post').send({}).expect(400);
      await excessApi('/999999999/candidates').expect(404);

      expect((query.body.errors as { field: string }[]).map((error) => error.field).sort()).toEqual(['linked', 'plantId']);
      expect(bodyless.body.errors[0]).toMatchObject({ field: 'purchaseOrderLineId', code: 'REQUIRED' });
    });
  });

  // 한 P/O 라인에 공급사 라벨 여러 장 — 라벨마다 한 줄이고 LOT 도 줄마다 선다(장부 P-99).
  it('입하 — 같은 P/O 라인 줄 여럿(라벨마다 한 줄)은 LOT 이 줄마다 서고 received_qty 는 합계만큼 오른다', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);

    const detail = await create({
      lines: [
        { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 40 },
        { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 35 },
      ],
    });

    expect(detail.lines.map((line) => line.purchaseOrderLineId)).toEqual([purchaseOrderLineId, purchaseOrderLineId]);
    expect(new Set(detail.lines.map((line) => line.lotId)).size).toBe(2);
    expect(detail.lines.every((line) => line.lotId !== null)).toBe(true);
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(75);
  });

  it('입하 — 같은 P/O 라인 줄들의 «합계»가 발주+허용치를 넘으면 첫 줄을 짚는 400 QTY_EXCEEDS_ORDERED 다', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    const lotsBefore = await prisma.lot.count({ where: { plant_id: plantId } });

    const rejected = await send(
      await body({
        lines: [
          { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 60 },
          { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 50 },
        ],
      }),
    ).expect(400);

    expect(rejected.body.errors).toEqual([
      expect.objectContaining({ field: 'lines.0.receivedQty', code: 'QTY_EXCEEDS_ORDERED' }),
    ]);
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
    expect(await prisma.lot.count({ where: { plant_id: plantId } })).toBe(lotsBefore);
  });

  it('⭐ 입하 등록과 P/O 라인 치환을 동시에 걸어도 500 이 없다(부모 FOR UPDATE 로 직렬화된다)', async () => {
    const order = await createOrder();
    const purchaseOrderLineId = order.lines[0].purchaseOrderLineId;
    const etag = await orderEtag(order.purchaseOrder.purchaseOrderId);

    const [receipt, replaced] = await Promise.all([
      send(await body({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 5 }] })),
      request(app.getHttpServer())
        .put(`/api/logistics/purchase-orders/${order.purchaseOrder.purchaseOrderId}/lines`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .set('If-Match', etag)
        .send({ items: [{ purchaseOrderLineId, itemId, orderedQty: 100, uomId }] }),
    ]);

    expect(receipt.status).toBeLessThan(500);
    expect(replaced.status).toBeLessThan(500);
  });

  it('입하 — 승인되지 않은 P/O 에도 입하가 붙는다(계약에 승인 문장이 0건이다 — 문의 023)', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await seedOrderLine(100);
    const order = await prisma.purchase_order.findUniqueOrThrow({
      where: { purchase_order_id: BigInt(purchaseOrderId) },
    });
    expect(order.approval_request_id).toBeNull();

    const detail = await create({
      lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 1 }],
    });

    expect(detail.lines[0].purchaseOrderLineId).toBe(purchaseOrderLineId);
  });

  it('입하 — 같은 Idempotency-Key 재전송도 같은 ETag 를 준다(201)', async () => {
    const draft = await body();
    const idempotencyKey = key();

    const first = await send(draft, idempotencyKey).expect(201);
    const second = await send(draft, idempotencyKey).expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(
      await prisma.inbound_receipt.count({
        where: { inbound_receipt_id: BigInt(first.body.inboundReceipt.inboundReceiptId) },
      }),
    ).toBe(1);
  });

  it('입하 — If-Match 없이 등록된다(선택이다 — 오프라인 큐는 토큰을 안 싣는다)', async () => {
    await send(await body()).expect(201);

    // 실려 와도 대조할 버전이 없다 — 서비스가 값을 무시한다(400 이 아니다).
    await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '"1"')
      .send(await body())
      .expect(201);
  });

  it('입하 — 권한 없는 사용자의 POST 는 403 이다(500 이 아니다)', async () => {
    await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(await body())
      .expect(403);
  });

  it('⭐ 원장이 움직이지 않는다 — inventory_transaction 이 0건 그대로다', async () => {
    await create();

    expect(await prisma.inventory_transaction.count({ where: { plant_id: plantId } })).toBe(0);
  });

  it('등록 — 본문의 inboundReceiptLineId 는 무시되고 신규 행으로 선다', async () => {
    const first = await create();
    const carried = first.lines[0].inboundReceiptLineId;

    const second = await create({ lines: [{ ...(await lineDraft()), inboundReceiptLineId: carried }] });

    expect(second.lines[0].inboundReceiptLineId).not.toBe(carried);
    expect(second.lines[0].lineNo).toBe(1);
  });

  it('등록 — deliveryNoteAttachmentId 를 받아도 400 이 아니다', async () => {
    const created = await send(await body({ deliveryNoteAttachmentId: 999999999 })).expect(201);

    expect((created.body as Detail).inboundReceipt.inboundReceiptId).toBeDefined();
  });

  it('입하 — 상세가 ETag 를 헤더로만 내린다(본문에 versionNo 가 없다)', async () => {
    const detail = await create();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers.etag).toMatch(/^\d+$/);
    expect(response.body.inboundReceipt).not.toHaveProperty('versionNo');
  });

  it('입하 — 없는 입하 상세는 404 다(계약 선언)', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/inbound-receipts/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('입하 — 라인 목록은 ETag 를 내리지 않는다(자식 컬렉션 · B-1-1)', async () => {
    const detail = await create();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}/lines`)
      .set('Cookie', cookie)
      .expect(200);

    // express 가 기본으로 약한 ETag 를 늘 붙인다 — 우리가 안 내렸다는 건 숫자 형식이 아님으로 본다(#196 리뷰 Minor).
    expect(response.headers.etag ?? '').not.toMatch(/^\d+$/);
  });

  it('입하 — 목록이 supplierId·plantId·statusCode·receiptDate 로 걸린다', async () => {
    const detail = await create();

    const found = await list(
      `supplierId=${supplierId}&plantId=${plantId}&statusCode=REGISTERED` +
        `&receiptDateFrom=${BUSINESS_DATE}&receiptDateTo=${BUSINESS_DATE}`,
    );

    expect(found.items.map((item) => item.inboundReceiptId)).toContain(
      detail.inboundReceipt.inboundReceiptId,
    );
  });

  it('입하 — P-01-01 의 조합 질의(supplierLotMissing=true&labelIssued=false)가 미부착 라인만 준다', async () => {
    const labeledAttached = await lineDraft();
    const plainAttached = await lineDraft();
    const missing = await lineDraft();
    const detail = await create({
      lines: [
        labeledAttached,
        plainAttached,
        { ...missing, supplierLotNo: null, supplierLotMissing: true, substituteLotReasonCode: 'NO_LABEL' },
      ],
    });

    // 첫 라인의 LOT 에 라벨 발행 기록을 직접 남긴다 — 발행은 P-01-01 의 몫이라 등록 API 가 모른다.
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    const labeledLotId = BigInt(detail.lines[0].lotId as number);
    await prisma.document_issue_log.create({
      data: {
        document_type_code: 'MATERIAL_LOT_LABEL',
        target_type_code: 'LOT',
        target_id: labeledLotId,
        lot_id: labeledLotId,
        issued_by: user.app_user_id,
      },
    });

    const response = await request(app.getHttpServer())
      .get(
        `/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}` +
          '/lines?supplierLotMissing=true&labelIssued=false',
      )
      .set('Cookie', cookie)
      .expect(200);

    // 라벨 발행된 부착 라인(1) · 미발행 부착 라인(2)은 supplierLotMissing 에서 이미 빠지고,
    // 미부착 라인(3)만 두 필터를 모두 통과한다 — AND 가 아니면 2도 섞여 나온다.
    const items = response.body.items as LineBody[];
    expect(items.map((item) => item.lineNo)).toEqual([3]);
  });


  // ── 헤더 수정 · 라인 치환 ────────────────────────────────────────────────

  it('수정 — If-Match 가 없으면 400 이다', async () => {
    const detail = await create();

    await request(app.getHttpServer())
      .put(`/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(headerBody())
      .expect(400);
  });

  it('수정 — 낡은 If-Match 로 수정하면 409 다', async () => {
    const detail = await create();
    const id = detail.inboundReceipt.inboundReceiptId;
    const etag = await receiptEtag(id);

    await putHeader(id, etag).expect(200);
    await putHeader(id, etag).expect(409);
  });

  it('수정 — 200 이 ETag 를 준다(다음 쓰기가 그대로 쓴다)', async () => {
    const detail = await create();
    const id = detail.inboundReceipt.inboundReceiptId;

    const first = await putHeader(id, await receiptEtag(id)).expect(200);

    expect(first.headers.etag).toMatch(/^\d+$/);
    expect((first.body as ReceiptBody).inboundReceiptId).toBe(id);
    await putHeader(id, first.headers.etag).expect(200);
  });

  it('수정 — 없는 입하를 수정하면 404 다(계약 미선언 — 알려둘 것 ⓒ)', async () => {
    await putHeader(999999999, '1').expect(404);
  });

  it('수정 — 권한 없는 사용자의 PUT 은 403 이다', async () => {
    const detail = await create();
    const id = detail.inboundReceipt.inboundReceiptId;
    const etag = await receiptEtag(id);

    await request(app.getHttpServer())
      .put(`/api/logistics/inbound-receipts/${id}`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(headerBody())
      .expect(403);
  });

  it('치환 — 없는 입하면 404', async () => {
    await putLines(999999999, '1', [newItem()]).expect(404);
  });

  it('치환 — If-Match 가 없으면 400', async () => {
    const detail = await create();

    await request(app.getHttpServer())
      .put(`/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}/lines`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items: [newItem()] })
      .expect(400);
  });

  it('치환 — 낡은 If-Match 면 409', async () => {
    const detail = await create({ lines: [await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;
    const etag = await receiptEtag(id);

    await putLines(id, etag, [newItem()]).expect(200);
    await putLines(id, etag, [newItem()]).expect(409);
  });

  it('치환 — 배열 순서가 lineNo 1..N 이 된다(요청이 lineNo 를 보내지 않는다)', async () => {
    const detail = await create({ lines: [await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;

    const items = await replace(id, [newItem({ receivedQty: 3 }), newItem({ receivedQty: 4 })]);

    expect(items.map((row) => row.lineNo)).toEqual([1, 2]);
    expect(items.map((row) => row.receivedQty)).toEqual([3, 4]);
  });

  it('치환 — 1↔2 를 맞바꿔도 uq_inbound_receipt_line 을 위반하지 않는다(한 트랜잭션)', async () => {
    const detail = await create({ lines: [await missingLotDraft(), await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;
    const [first, second] = detail.lines;

    const items = await replace(id, [itemOf(second), itemOf(first)]);

    expect(items.map((row) => row.inboundReceiptLineId)).toEqual([
      second.inboundReceiptLineId,
      first.inboundReceiptLineId,
    ]);
    expect(items.map((row) => row.lineNo)).toEqual([1, 2]);
  });

  it('치환 — 요청에서 빠진 기존 행은 지워진다', async () => {
    const detail = await create({ lines: [await missingLotDraft(), await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;

    const items = await replace(id, [itemOf(detail.lines[0])]);

    expect(items).toHaveLength(1);
    expect(items[0].inboundReceiptLineId).toBe(detail.lines[0].inboundReceiptLineId);
  });

  it('치환 — LOT 이 만들어진 라인을 지우면 400 STATE_LOCKED 다(계약이 코드까지 적었다)', async () => {
    const detail = await create({ lines: [await lineDraft(), await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;
    expect(detail.lines[0].lotId).not.toBeNull();

    const rejected = await putLines(id, await receiptEtag(id), [itemOf(detail.lines[1])]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('치환 — 입고가 붙은 라인을 지우면 400 SUCCESSOR_EXISTS 다(§7-4 · FK 위반이 500 으로 새지 않는다)', async () => {
    const detail = await create({ lines: [await missingLotDraft(), await lineDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;
    await seedGoodsReceipt(detail.lines[0], detail.lines[1].lotId as number);

    const rejected = await putLines(id, await receiptEtag(id), [itemOf(detail.lines[1])]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
  });

  it('치환 — 입고가 붙은 라인의 수량을 바꿔도 400 SUCCESSOR_EXISTS 다(계약이 삭제만 막았다)', async () => {
    const detail = await create({ lines: [await missingLotDraft(), await lineDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;
    await seedGoodsReceipt(detail.lines[0], detail.lines[1].lotId as number);

    const rejected = await putLines(id, await receiptEtag(id), [
      itemOf(detail.lines[0], { receivedQty: 99 }),
      itemOf(detail.lines[1]),
    ]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
  });

  it('치환 — 차이가 붙은 라인을 지우면 400 이다(inbound_variance FK)', async () => {
    const detail = await create({ lines: [await missingLotDraft(), await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;
    await prisma.inbound_variance.create({
      data: {
        inbound_receipt_line_id: BigInt(detail.lines[0].inboundReceiptLineId),
        variance_type_code: 'SHORTAGE',
        variance_qty: 1,
        uom_id: BigInt(uomId),
      },
    });

    const rejected = await putLines(id, await receiptEtag(id), [itemOf(detail.lines[1])]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
  });

  it('치환 — 200 에 ETag 가 없다(계약이 헤더를 선언하지 않았다)', async () => {
    const detail = await create({ lines: [await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;

    const response = await putLines(id, await receiptEtag(id), [newItem()]).expect(200);

    // express 가 기본으로 약한 ETag 를 늘 붙인다 — 우리가 안 내렸다는 건 숫자 형식이 아님으로 본다.
    expect(response.headers.etag ?? '').not.toMatch(/^\d+$/);
  });

  it('치환 — 부모 version_no 는 오른다(다음 If-Match 는 상세 GET 이 준다)', async () => {
    const detail = await create({ lines: [await missingLotDraft()] });
    const id = detail.inboundReceipt.inboundReceiptId;
    const before = await receiptEtag(id);

    await putLines(id, before, [newItem()]).expect(200);

    expect(Number(await receiptEtag(id))).toBe(Number(before) + 1);
  });

  it('치환 — 수량을 내리면 received_qty 도 내린다(차분)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    const detail = await create({
      lines: [{ ...(await missingLotDraft()), purchaseOrderLineId, receivedQty: 30 }],
    });
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(30);

    await replace(detail.inboundReceipt.inboundReceiptId, [
      itemOf(detail.lines[0], { receivedQty: 10 }),
    ]);

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(10);
  });

  it('입하 — ERP 가 취소한 P/O 라인으로 등록하면 400 이고 received_qty 가 그대로다(장부 P-73)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    await prisma.purchase_order_line.update({
      where: { purchase_order_line_id: BigInt(purchaseOrderLineId) },
      data: { cancelled_at: new Date() },
    });

    const rejected = await send(
      await body({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 5 }] }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lines.0.purchaseOrderLineId',
      code: 'INVALID',
      message: 'ERP 에서 취소한 P/O 라인입니다.',
    });
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
  });

  it('치환 — 등록 뒤 ERP 가 취소한 P/O 라인은 늘리면 400 이고 줄이기는 된다(장부 P-73)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    const detail = await create({
      lines: [{ ...(await missingLotDraft()), purchaseOrderLineId, receivedQty: 30 }],
    });
    const id = detail.inboundReceipt.inboundReceiptId;
    await prisma.purchase_order_line.update({
      where: { purchase_order_line_id: BigInt(purchaseOrderLineId) },
      data: { cancelled_at: new Date() },
    });

    const rejected = await putLines(id, await receiptEtag(id), [
      itemOf(detail.lines[0], { receivedQty: 40 }),
    ]).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'items.0.purchaseOrderLineId', code: 'INVALID' });
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(30);

    await replace(id, [itemOf(detail.lines[0], { receivedQty: 10 })]);
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(10);
  });

  it('치환 — 라인을 지우면 received_qty 가 그만큼 내린다', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    const detail = await create({
      lines: [
        { ...(await missingLotDraft()), purchaseOrderLineId, receivedQty: 30 },
        await missingLotDraft(),
      ],
    });

    await replace(detail.inboundReceipt.inboundReceiptId, [itemOf(detail.lines[1])]);

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
  });

  it('치환 — items 가 빈 배열이면 400 LINE_REQUIRED 다', async () => {
    const detail = await create();
    const id = detail.inboundReceipt.inboundReceiptId;

    const rejected = await putLines(id, await receiptEtag(id), []).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'items', code: 'LINE_REQUIRED' });
  });

  it('치환 — 권한 없는 사용자의 PUT 은 403 이다', async () => {
    const detail = await create();
    const id = detail.inboundReceipt.inboundReceiptId;
    const etag = await receiptEtag(id);

    await request(app.getHttpServer())
      .put(`/api/logistics/inbound-receipts/${id}/lines`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ items: [newItem()] })
      .expect(403);
  });

  // ── 초과 분리 등록 · 차이 등록 ────────────────────────────────────────────

  it('분리 — mode=BOTH 가 입하 2건을 만들고 번호가 서로 다르다', async () => {
    const created = await split();

    expect(created).toHaveLength(2);
    expect(created[0].inboundReceiptNo).not.toBe(created[1].inboundReceiptNo);
    for (const receipt of created) expect(receipt.inboundReceiptNo).toMatch(/^IR-20260806-\d{4,}$/);
  });

  it('분리 — mode=NORMAL_ONLY 는 1건만 만든다', async () => {
    const created = await split({ mode: 'NORMAL_ONLY', excess: undefined });

    expect(created).toHaveLength(1);
  });

  it('분리 — mode=EXCESS_ONLY 는 1건만 만든다', async () => {
    const created = await split({ mode: 'EXCESS_ONLY', normal: undefined });

    expect(created).toHaveLength(1);
  });

  it('분리 — 어느 part 의 lines 가 비면 400 LINE_REQUIRED', async () => {
    const rejected = await sendSplit(await splitBody({ excess: await splitPart({ lines: [] }) })).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'excess.lines', code: 'LINE_REQUIRED' });
  });

  it('분리 — 초과분이 실패하면 정량분도 없다(한 트랜잭션 · 부분 저장 금지)', async () => {
    const before = await prisma.inbound_receipt.count({ where: { plant_id: plantId } });

    // 검증을 통과한 뒤 트랜잭션 «안»에서 깨지는 값 — 없는 uom 이라 라인 삽입이 FK 위반이다.
    const draft = await lineDraft();
    await sendSplit(
      await splitBody({ excess: await splitPart({ lines: [{ ...draft, uomId: 999999999 }] }) }),
    ).expect(400);

    expect(await prisma.inbound_receipt.count({ where: { plant_id: plantId } })).toBe(before);
  });

  it('분리 — 정량분만 received_qty 를 올린다(초과분은 P/O 비귀속)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    const normalLine = { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 30 };

    await split({ normal: await splitPart({ lines: [normalLine] }) });

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(30);
  });

  it('분리 — 정량분에 같은 P/O 라인 줄 여럿을 실으면 합계로 검사하고 합계만큼 올린다', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    const normal = async (receivedQty: number) => ({ ...(await lineDraft()), purchaseOrderLineId, receivedQty });

    const rejected = await sendSplit(
      await splitBody({ normal: await splitPart({ lines: [await normal(70), await normal(40)] }) }),
    ).expect(400);
    expect(rejected.body.errors).toEqual([
      expect.objectContaining({ field: 'normal.lines.0.receivedQty', code: 'QTY_EXCEEDS_ORDERED' }),
    ]);

    await split({ normal: await splitPart({ lines: [await normal(70), await normal(30)] }) });
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(100);
  });

  it('분리 — 요청이 원본 입하를 가리키지 않는다(원 도착은 저장된 적이 없다 — W-01-03 §5-1)', async () => {
    const original = await create();
    const before = await prisma.inbound_receipt.count({ where: { plant_id: plantId } });

    const created = await split();

    expect(created.map((receipt) => receipt.inboundReceiptId)).not.toContain(
      original.inboundReceipt.inboundReceiptId,
    );
    expect(await prisma.inbound_receipt.count({ where: { plant_id: plantId } })).toBe(before + 2);
    const reloaded = await prisma.inbound_receipt.findUniqueOrThrow({
      where: { inbound_receipt_id: BigInt(original.inboundReceipt.inboundReceiptId) },
    });
    expect(reloaded.version_no).toBe(1);
  });

  it('분리 — 응답 created 순서가 정량분·초과분이다', async () => {
    const created = await split({
      excess: await splitPart({ exceptionTypeCode: 'OVER_DELIVERY', exceptionReason: '초과 도착' }),
    });

    expect(created[0].exceptionTypeCode).toBeNull();
    expect(created[1].exceptionTypeCode).toBe('OVER_DELIVERY');
  });

  it('분리 — 같은 Idempotency-Key 재전송도 201 이고 건이 늘지 않는다', async () => {
    const draft = await splitBody();
    const idempotencyKey = key();

    const first = await sendSplit(draft, idempotencyKey).expect(201);
    const before = await prisma.inbound_receipt.count({ where: { plant_id: plantId } });
    const second = await sendSplit(draft, idempotencyKey).expect(201);

    expect(second.body).toEqual(first.body);
    expect(await prisma.inbound_receipt.count({ where: { plant_id: plantId } })).toBe(before);
  });

  it('분리 — 정량분·초과분이 같은 공급사 LOT 을 실으면 400 INVALID 가 초과분 칸을 짚는다', async () => {
    const receiptsBefore = await prisma.inbound_receipt.count({ where: { plant_id: plantId } });
    const lotsBefore = await prisma.lot.count({ where: { plant_id: plantId } });
    // W-01-03 대표 시나리오 — 한 물리 LOT 이 정량분·초과분으로 갈린다(문의 029).
    const shared = await lineDraft();

    const rejected = await sendSplit(
      await splitBody({
        normal: await splitPart({ lines: [shared] }),
        excess: await splitPart({ lines: [{ ...shared, receivedQty: 20 }] }),
      }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'excess.lines.0.supplierLotNo',
      code: 'INVALID',
    });
    expect(await prisma.inbound_receipt.count({ where: { plant_id: plantId } })).toBe(receiptsBefore);
    expect(await prisma.lot.count({ where: { plant_id: plantId } })).toBe(lotsBefore);
  });

  // 줄마다 입하 한 건(장부 P-117) — 일괄 입하도 품목마다 입하번호가 따로 붙는다(사용자 결정 2026-10-24).
  describe('줄마다 입하 한 건 (:per-line)', () => {
    function sendPerLine(draft: object, as = cookie): request.Test {
      return request(app.getHttpServer())
        .post('/api/logistics/inbound-receipts:per-line')
        .set('Cookie', as)
        .set('Idempotency-Key', key())
        .set('X-Worker-No', 'W-0001')
        .send(draft);
    }

    it('줄 셋이면 입하 세 건 — 입하번호가 모두 다르고 건마다 줄 하나·헤더 값은 같다 · P/O 받은 수량·배정도 줄마다', async () => {
      const { purchaseOrderLineId } = await seedOrderLine(100);
      const lines = [
        { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 10 },
        { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 20 },
        { ...(await lineDraft()), receivedQty: 5 },
      ];

      const response = await sendPerLine(await body({ lines })).expect(201);

      const created = (response.body as { created: Detail[] }).created;
      expect(created).toHaveLength(3);
      const numbers = created.map((detail) => detail.inboundReceipt.inboundReceiptNo);
      expect(new Set(numbers).size).toBe(3);
      expect(created.map((detail) => detail.lines.map((line) => [line.lineNo, line.receivedQty]))).toEqual([[[1, 10]], [[1, 20]], [[1, 5]]]);
      const headers = created.map((detail) => detail.inboundReceipt as ReceiptBody & { supplierId: number; receiptDatetime: string });
      expect(new Set(headers.map((header) => `${header.supplierId}|${header.receiptDatetime}`)).size).toBe(1);
      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(30);
      expect(await allocationsOf(created[1].lines[0].inboundReceiptLineId)).toEqual([[purchaseOrderLineId, 20]]);
      // 건마다 따로 조회된다 — 상세가 그 건의 줄 하나만 낸다.
      const detail = await request(app.getHttpServer())
        .get(`/api/logistics/inbound-receipts/${created[2].inboundReceipt.inboundReceiptId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect((detail.body as Detail).lines).toHaveLength(1);
    });

    it('한 줄이라도 막히면 아무것도 서지 않는다 — 400 이 그 줄(lines.{i})을 짚는다', async () => {
      const { purchaseOrderLineId } = await seedOrderLine(25);
      const before = await prisma.inbound_receipt.count({ where: { plant_id: plantId } });
      const lines = [
        { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 10 },
        { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 10 },
        // 앞 두 줄이 20 을 올린 뒤라 이 줄이 한도(25)를 넘는다.
        { ...(await lineDraft()), purchaseOrderLineId, receivedQty: 10 },
      ];

      const rejected = await sendPerLine(await body({ lines })).expect(400);

      expect(rejected.body.errors).toEqual([expect.objectContaining({ field: 'lines.2.receivedQty', code: 'QTY_EXCEEDS_ORDERED' })]);
      expect(await prisma.inbound_receipt.count({ where: { plant_id: plantId } })).toBe(before);
      expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
    });

    it('검사는 입하 등록과 같다 — 본문 형식 400 · 줄 없음 LINE_REQUIRED · 권한 없음 403 · 로그인 없음 401', async () => {
      const invalid = await sendPerLine(await body({ lines: [{ ...(await lineDraft()), receivedQty: 'x' }] })).expect(400);
      // 계약 검증기가 막았다(입하 등록과 같은 모양 — 검증기의 칸 표기 lines[0]).
      expect(invalid.body.errors[0]).toMatchObject({ field: 'lines[0].receivedQty' });
      const empty = await sendPerLine(await body({ lines: [] })).expect(400);
      expect(empty.body.errors[0]).toMatchObject({ code: 'LINE_REQUIRED' });
      await sendPerLine(await body(), noPermCookie).expect(403);
      await request(app.getHttpServer()).post('/api/logistics/inbound-receipts:per-line').send(await body()).expect(401);
    });

    it('⭐ 웹 입하 등록 권한(W-01-03)만 있어도 등록한다 — 웹 입고 관리의 「라인 표에서 바로 입하」(사용자 결정 2026-10-27)', async () => {
      const response = await sendPerLine(await body(), webCookie).expect(201);
      expect((response.body as { created: Detail[] }).created).toHaveLength(1);
    });
  });

  // 입하 건을 가로지르는 줄 목록 · 공급사별 수(장부 P-118) — POP 자재 LOT 라벨 발행(P-01-01).
  describe('입하 줄 목록 (라벨 발행 대기)', () => {
    // 다른 검사의 줄과 섞이지 않게 이 묶음만의 입하 날짜로 거른다.
    const DAY = '2031-03-04';
    const window = `receiptDateFrom=${DAY}&receiptDateTo=${DAY}`;
    const lotless = async (receivedQty: number) => ({
      ...(await lineDraft()), receivedQty, supplierLotNo: null, supplierLotMissing: true, substituteLotReasonCode: 'NO_LABEL',
    });
    const get = (path: string, as = cookie) => request(app.getHttpServer()).get(`/api/logistics/${path}`).set('Cookie', as);
    type Row = { inboundReceiptLineId: number; inboundReceiptNo: string; lineNo: number; lotId: number | null; lastLabelIssue: object | null };

    let first: Detail;
    let second: Detail;
    beforeAll(async () => {
      first = await create({ receiptDatetime: `${DAY}T01:00:00Z`, lines: [await lotless(3), await lotless(4)] });
      // 둘째 건은 미부착 하나 + 라벨이 붙어 온 줄 하나(이 줄은 대기가 아니다).
      second = await create({ receiptDatetime: `${DAY}T02:00:00Z`, lines: [await lotless(5), await lineDraft()] });
    });

    it('대기 줄 — 미부착이고 발행 기록이 없는 줄이 입하 일시 → 줄 번호 순으로 건을 가로질러 나온다', async () => {
      const response = await get(`inbound-receipt-lines?labelIssued=false&supplierLotLabelAttached=false&${window}`).expect(200);
      const rows = response.body.items as Row[];
      expect(rows.map((row) => [row.inboundReceiptNo, row.lineNo])).toEqual([
        [first.inboundReceipt.inboundReceiptNo, 1],
        [first.inboundReceipt.inboundReceiptNo, 2],
        [second.inboundReceipt.inboundReceiptNo, 1],
      ]);
      expect(rows[0]).toMatchObject({ supplierId, plantId, itemId, receivedQty: 3, uomId, lotId: null, lotNo: null, lastLabelIssue: null });
      expect(response.body.page.total).toBe(3);
    });

    it('LOT 만 등록하고 인쇄하지 못한 줄은 대기에 남고, 발행 기록이 생기면 빠져 labelIssued=true 쪽에 마지막 회차와 함께 나온다', async () => {
      const lineId = first.lines[1].inboundReceiptLineId;
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LBL-${lotSeq}`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: plantId, initial_qty: 4,
          uom_id: uomId, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: lineId, status_code: 'NORMAL',
        },
      });
      await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: lineId }, data: { lot_id: lot.lot_id } });
      const pending = async () =>
        ((await get(`inbound-receipt-lines?labelIssued=false&supplierLotLabelAttached=false&${window}`).expect(200)).body.items as Row[])
          .find((row) => row.inboundReceiptLineId === lineId);
      expect(await pending()).toMatchObject({ lotId: Number(lot.lot_id), lastLabelIssue: null });

      // 발행은 P-01-01 의 몫이라 기록을 직접 남긴다 — 처음 발행과 다시 인쇄 한 번.
      const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
      for (const seq of [1, 2]) {
        await prisma.document_issue_log.create({
          data: {
            document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: lot.lot_id, lot_id: lot.lot_id,
            issue_seq: seq, issued_by: user.app_user_id, ...(seq > 1 ? { reissue_reason_code: 'DAMAGED' } : {}),
          },
        });
      }

      expect(await pending()).toBeUndefined();
      const issued = (await get(`inbound-receipt-lines?labelIssued=true&${window}`).expect(200)).body.items as Row[];
      expect(issued.find((row) => row.inboundReceiptLineId === lineId)).toMatchObject({
        lotNo: lot.lot_no, lotStatusCode: 'NORMAL', lastLabelIssue: { issueSeq: 2, issuedAt: expect.any(String) },
      });
    });

    it('공급사별 수 — 같은 조건의 줄을 공급사로 묶고 가장 먼저 입하된 시각을 싣는다 · 취소한 입하는 빠진다', async () => {
      const counts = async () =>
        (await get(`inbound-receipt-lines:supplier-counts?labelIssued=false&supplierLotLabelAttached=false&${window}`).expect(200)).body;
      // 앞 검사가 한 줄을 발행했다 — 남은 대기는 첫 건 1 + 둘째 건 1.
      expect(await counts()).toEqual({
        items: [expect.objectContaining({ supplierId, pendingCount: 2, firstReceiptDatetime: `${DAY}T01:00:00.000Z` })],
      });
      await prisma.inbound_receipt.update({ where: { inbound_receipt_id: BigInt(second.inboundReceipt.inboundReceiptId) }, data: { status_code: 'CANCELLED' } });
      expect((await counts()).items[0]).toMatchObject({ pendingCount: 1 });
    });

    it('검사는 입하 목록과 같다 — 질의 형식 400 · 로그인 없음 401', async () => {
      await get(`inbound-receipt-lines?labelIssued=maybe`).expect(400);
      await get(`inbound-receipt-lines:supplier-counts?receiptDateFrom=2031-02-30`).expect(400);
      await request(app.getHttpServer()).get('/api/logistics/inbound-receipt-lines').expect(401);
    });
  });

  it('분리 — 권한 없는 사용자의 POST 는 403', async () => {
    await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts:split')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(await splitBody())
      .expect(403);
  });

  it('차이 — 등록 응답이 계약 InboundVariance 를 만족한다', async () => {
    const detail = await create();
    const variance = await addVariance(detail.lines[0].inboundReceiptLineId);

    const validate = validator(
      'POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances',
      201,
    );
    expect(validate(variance)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 채우는 경로가 계약에 0건이라 늘 널이다 — 키를 생략하지 않는다.
    expect(variance).toHaveProperty('approvalRequestId', null);
  });

  it('차이 — 같은 라인에 두 번 등록해도 막지 않는다(유일 제약이 없다)', async () => {
    const detail = await create();
    const inboundReceiptLineId = detail.lines[0].inboundReceiptLineId;

    await addVariance(inboundReceiptLineId);
    await addVariance(inboundReceiptLineId, { varianceTypeCode: 'ITEM_MISMATCH', reasonCode: 'DAMAGED' });

    expect(
      await prisma.inbound_variance.count({
        where: { inbound_receipt_line_id: BigInt(inboundReceiptLineId) },
      }),
    ).toBe(2);
  });

  it('차이 — 등록해도 received_qty 가 그대로다(원장도 라인 상태도 안 움직인다)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);
    const detail = await create({
      lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 30 }],
    });
    const line = detail.lines[0];

    await addVariance(line.inboundReceiptLineId, { varianceQty: 12 });

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(30);
    const reloaded = await prisma.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: BigInt(line.inboundReceiptLineId) },
    });
    expect(Number(reloaded.received_qty)).toBe(30);
    expect(reloaded.status_code).toBe('REGISTERED');
    expect(reloaded.lot_id).not.toBeNull();
  });

  it('차이 — 없는 라인에 등록하면 404 다(계약 미선언 — 알려둘 것 ⓒ)', async () => {
    await sendVariance(999999999, varianceBody()).expect(404);
  });

  it('차이 — 권한 없는 사용자의 POST 는 403 이다', async () => {
    const detail = await create();

    await request(app.getHttpServer())
      .post(`/api/logistics/inbound-receipt-lines/${detail.lines[0].inboundReceiptLineId}/variances`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(varianceBody())
      .expect(403);
  });

  it('⭐ 원장이 움직이지 않는다 — 12건 전건 뒤 inventory_transaction 이 0건이다', async () => {
    const created = await split();
    const lines = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${created[0].inboundReceiptId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    await addVariance((lines.body.items as LineBody[])[0].inboundReceiptLineId);

    expect(await prisma.inventory_transaction.count({ where: { plant_id: plantId } })).toBe(0);
  });

  // ── 도우미 ────────────────────────────────────────────────────────────────

  function sendSplit(draft: object, idempotencyKey = key()): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts:split')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(draft);
  }

  async function split(overrides: object = {}): Promise<ReceiptBody[]> {
    const created = await sendSplit(await splitBody(overrides)).expect(201);
    return (created.body as { created: ReceiptBody[] }).created;
  }

  /** ⛔ `businessDate`·`occurredAt` 은 «바깥에서 한 번»이다 — part 에는 칸이 없다(계약). */
  async function splitBody(overrides: object = {}): Promise<object> {
    return {
      mode: 'BOTH',
      normal: await splitPart(),
      excess: await splitPart(),
      businessDate: BUSINESS_DATE,
      occurredAt: RECEIPT_AT,
      ...overrides,
    };
  }

  /** 기본 part 의 라인은 «무발주»다 — `:split` 에는 등록의 「무발주면 예외 유형 필수」가 안 선다(R-7 ②). */
  async function splitPart(overrides: object = {}): Promise<object> {
    return {
      supplierId,
      plantId,
      receiptDatetime: RECEIPT_AT,
      lines: [await lineDraft()],
      ...overrides,
    };
  }

  function varianceBody(overrides: object = {}): object {
    return { varianceTypeCode: 'SHORTAGE', varianceQty: 5, uomId, ...overrides };
  }

  function sendVariance(inboundReceiptLineId: number, draft: object): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/inbound-receipt-lines/${inboundReceiptLineId}/variances`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('X-Worker-No', 'W-0001')
      .send(draft);
  }

  async function addVariance(inboundReceiptLineId: number, overrides: object = {}): Promise<object> {
    const created = await sendVariance(inboundReceiptLineId, varianceBody(overrides)).expect(201);
    return created.body as object;
  }

  async function list(qs: string): Promise<{ items: ReceiptBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts?${qs}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as { items: ReceiptBody[] };
  }

  function send(draft: object, idempotencyKey = key()): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Worker-No', 'W-0001')
      .send(draft);
  }

  async function create(overrides: object = {}): Promise<Detail> {
    const created = await send(await body(overrides)).expect(201);
    return created.body as Detail;
  }

  /** 기본 라인은 «무발주»다 — 그래서 예외 유형·사유가 늘 실린다(R-7 ②). P/O 귀속을
   *  보는 검사만 `purchaseOrderLineId` 를 덮어쓴다. */
  async function body(overrides: object = {}): Promise<object> {
    return {
      supplierId,
      plantId,
      receiptDatetime: RECEIPT_AT,
      businessDate: BUSINESS_DATE,
      occurredAt: RECEIPT_AT,
      exceptionTypeCode: 'CUSTOMER_SUPPLY',
      exceptionReason: '무발주 도착',
      lines: [await lineDraft()],
      ...overrides,
    };
  }

/**
 * 사전부착(`supplierLotLabelAttached`) 라인의 공급사 LOT 번호는 구분자 5칸 형식이어야 한다
 * (`inbound-receipt-rules.ts` · 통보 277). `uq_lot(plant_id, lot_no)` 때문에 호출마다 새 값이라
 * 번호 칸에 순번을 넣는다.
 */
function supplierLotNoOf(seq: number): string {
  return `${ITEM_CODE}|10|${BUSINESS_DATE.replace(/-/g, '').slice(2)}|${SUPPLIER_CODE}|${String(seq).padStart(4, '0')}`;
}

  /** `uq_lot(plant_id, lot_no)` 때문에 공급사 LOT 번호는 호출마다 새 값이다. */
  async function lineDraft(): Promise<LineDraft> {
    lotSeq += 1;
    return {
      itemId,
      receivedQty: 10,
      uomId,
      supplierLotNo: supplierLotNoOf(lotSeq),
      supplierLotMissing: false,
    };
  }

  function headerBody(overrides: object = {}): object {
    return {
      supplierId,
      receiptDatetime: RECEIPT_AT,
      deliveryNoteNo: 'DN-2026-000045',
      vehicleNo: 'V-0001',
      dockLocationId: dockId,
      remarks: '수정 검사',
      ...overrides,
    };
  }

  function putHeader(inboundReceiptId: number, etag: string): request.Test {
    return request(app.getHttpServer())
      .put(`/api/logistics/inbound-receipts/${inboundReceiptId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(headerBody());
  }

  function putLines(inboundReceiptId: number, etag: string, items: object[]): request.Test {
    return request(app.getHttpServer())
      .put(`/api/logistics/inbound-receipts/${inboundReceiptId}/lines`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ items });
  }

  async function replace(inboundReceiptId: number, items: object[]): Promise<LineBody[]> {
    const etag = await receiptEtag(inboundReceiptId);
    const response = await putLines(inboundReceiptId, etag, items).expect(200);
    return (response.body as { items: LineBody[] }).items;
  }

  async function receiptEtag(inboundReceiptId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${inboundReceiptId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  /** 응답 라인을 그대로 치환 요청 항목으로 되돌린다 — 「빠진 행은 삭제」라 전건을 다시 싣는다. */
  function itemOf(line: LineBody, overrides: object = {}): object {
    return {
      inboundReceiptLineId: line.inboundReceiptLineId,
      purchaseOrderLineId: line.purchaseOrderLineId,
      itemId,
      receivedQty: line.receivedQty,
      uomId,
      supplierLotNo: line.supplierLotNo,
      supplierLotMissing: line.supplierLotMissing,
      substituteLotReasonCode: line.substituteLotReasonCode,
      ...overrides,
    };
  }

  /** 신규 행 — 치환은 LOT 을 만들지 않으므로 미부착으로 세운다(§5-1). */
  function newItem(overrides: object = {}): object {
    return {
      itemId,
      receivedQty: 7,
      uomId,
      supplierLotMissing: true,
      substituteLotReasonCode: 'NO_LABEL',
      ...overrides,
    };
  }

  /** 미부착 라인 — LOT 이 안 서므로 계약의 삭제 가드에 안 걸린다. */
  async function missingLotDraft(): Promise<LineDraft> {
    return {
      ...(await lineDraft()),
      supplierLotNo: null,
      supplierLotMissing: true,
      substituteLotReasonCode: 'NO_LABEL',
    };
  }

  /** ⛔ 입고를 API 로 만들면 원장이 생겨 「inventory_transaction 0건」 단언이 거짓이 된다 —
   *  직접 INSERT 다(R-10). `lot_id` 가 NOT NULL 이라 같은 입하가 만든 LOT 을 그대로 쓴다. */
  async function seedGoodsReceipt(line: LineBody, lotId: number): Promise<void> {
    receiptSeq += 1;
    const receipt = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR-${receiptSeq}`,
        receipt_type_code: 'PURCHASE',
        plant_id: BigInt(plantId),
        warehouse_id: BigInt(warehouseId),
        receipt_datetime: new Date(RECEIPT_AT),
        status_code: 'POSTED',
      },
    });
    await prisma.goods_receipt_line.create({
      data: {
        goods_receipt_id: receipt.goods_receipt_id,
        line_no: 1,
        inbound_receipt_line_id: BigInt(line.inboundReceiptLineId),
        item_id: BigInt(itemId),
        lot_id: BigInt(lotId),
        receipt_qty: line.receivedQty,
        uom_id: BigInt(uomId),
        quality_status_code: 'OK',
        inventory_status_code: 'AVAILABLE',
        destination_location_id: BigInt(dockId),
      },
    });
  }

  async function poLine(purchaseOrderLineId: number) {
    return prisma.purchase_order_line.findUniqueOrThrow({
      where: { purchase_order_line_id: BigInt(purchaseOrderLineId) },
    });
  }

  /** 줄의 배정 몫 — `[P/O 라인, 수량]` 쌍, 만든 순서. */
  async function allocationsOf(inboundReceiptLineId: number): Promise<[number, number][]> {
    const rows = await prisma.inbound_receipt_po_allocation.findMany({
      where: { inbound_receipt_line_id: BigInt(inboundReceiptLineId) },
      orderBy: { inbound_receipt_po_allocation_id: 'asc' },
    });
    return rows.map((row) => [Number(row.purchase_order_line_id), Number(row.allocated_qty)]);
  }

  /** 귀속 대상 P/O 는 직접 INSERT 다 — 등록 API 는 이 슬라이스 밖이다. */
  async function seedOrderLine(
    orderedQty: number,
    toleranceOverQty = 0,
  ): Promise<{ purchaseOrderId: number; purchaseOrderLineId: number }> {
    orderSeq += 1;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${orderSeq}`,
        supplier_id: BigInt(supplierId),
        business_unit_id: BigInt(businessUnitId),
        plant_id: BigInt(plantId),
        order_date: new Date(`${BUSINESS_DATE}T00:00:00.000Z`),
        status_code: 'REGISTERED',
      },
    });
    const line = await prisma.purchase_order_line.create({
      data: {
        purchase_order_id: order.purchase_order_id,
        line_no: 1,
        item_id: BigInt(itemId),
        ordered_qty: orderedQty,
        uom_id: BigInt(uomId),
        tolerance_over_qty: toleranceOverQty,
      },
    });
    return {
      purchaseOrderId: Number(order.purchase_order_id),
      purchaseOrderLineId: Number(line.purchase_order_line_id),
    };
  }

  /** 동시성 검사 하나만 P/O 를 API 로 만든다 — 라인 치환에 담을 ETag 가 필요하다. */
  async function createOrder(): Promise<{
    purchaseOrder: { purchaseOrderId: number };
    lines: { purchaseOrderLineId: number }[];
  }> {
    const created = await request(app.getHttpServer())
      .post('/api/logistics/purchase-orders')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        supplierId,
        businessUnitId,
        plantId,
        orderDate: BUSINESS_DATE,
        lines: [{ itemId, orderedQty: 100, uomId }],
      })
      .expect(201);
    return created.body as { purchaseOrder: { purchaseOrderId: number }; lines: { purchaseOrderLineId: number }[] };
  }

  async function orderEtag(purchaseOrderId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-orders/${purchaseOrderId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '입하검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '입하검사사업부',
      },
    });
    businessUnitId = Number(unit.business_unit_id);
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '입하검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    // `inspection_required` 는 이 품목에서 승계된다(계약 · I-3.md §5-2).
    const item = await prisma.item.create({
      data: {
        item_code: ITEM_CODE,
        item_name: '입하검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        inspection_required: true,
      },
    });
    itemId = Number(item.item_id);
    // ⛔ 검사 대상 품목은 «확정된» IQC 검사기준이 «정확히 하나» 있어야 LOT 이 선다
    //    (`lot-registry.service.ts:227` · #610). 없으면 입하 등록 자체가 400 STATE_LOCKED 다.
    const iqcPlan = await prisma.inspection_plan.create({
      data: {
        inspection_plan_code: `${PREFIX}-IQC`,
        inspection_plan_name: '입하검사기준',
        inspection_type_code: 'IQC',
        item_id: item.item_id,
        is_active: true,
      },
    });
    await prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: iqcPlan.inspection_plan_id,
        plan_version: 1,
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        sampling_method_code: 'FULL',
        inspection_frequency_code: 'EVERY_LOT',
        status_code: 'CONFIRMED',
      },
    });

    const supplier = await prisma.partner.create({
      data: { partner_code: SUPPLIER_CODE, partner_name: '입하검사공급사' },
    });
    supplierId = Number(supplier.partner_id);

    // 하역 위치(헤더 수정의 `dockLocationId`)와 입고 픽스처(§7-4)가 쓸 창고·위치.
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '입하검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const dock = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-DOCK`,
        location_name: '입하장',
        location_type_code: 'BIN',
      },
    });
    dockId = Number(dock.location_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '입하등록검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);
    const web = await prisma.app_user.create({ data: { login_id: WEB_ID, user_name: '웹입하만', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: web.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const webRole = await prisma.role.create({ data: { role_code: WEB_ROLE, role_name: '웹입하등록만' } });
    await prisma.role_permission.create({ data: { role_id: webRole.role_id, permission_code: 'W-01-03' } });
    await prisma.user_role.create({ data: { app_user_id: web.app_user_id, role_id: webRole.role_id } });
    webCookie = await login(WEB_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '입하등록검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /**
   * ⭐ `inbound_receipt_line` 이 `trace.lot` 을 «가리킨다» — LOT 을 먼저 지우면 FK 위반이다
   * (I-3.md §6-5 ②가 ④보다 먼저). `lot_hold`·`lot_external_identifier` 는 LOT 의 자식이다.
   */
  async function cleanup(): Promise<void> {
    const ownPlants = `(SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    const ownLots = `(SELECT lot_id FROM trace.lot WHERE plant_id IN ${ownPlants})`;
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_variance
       WHERE inbound_receipt_line_id IN (
         SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line
          WHERE inbound_receipt_id IN (
            SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants})
       )`);
    // `goods_receipt_line` 이 입하 라인·LOT·위치를 모두 가리킨다 — 셋보다 먼저 지운다(R-10).
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt_line
       WHERE goods_receipt_id IN (
         SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN ${ownPlants})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_line
       WHERE inbound_receipt_id IN (
         SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_hold WHERE lot_id IN ${ownLots}`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN ${ownLots}`,
    );
    // `app.document_issue_log` 가 `trace.lot` 을 가리킨다(labelIssued 픽스처) — lot 보다 먼저(R-10).
    await prisma.$executeRawUnsafe(`DELETE FROM app.document_issue_log WHERE lot_id IN ${ownLots}`);
    // ⛔ 검사 대상 품목의 LOT 이 서면 IQC 의뢰가 «자동으로» 딸려 난다(#610). 그것도 lot 보다
    //    먼저 지운다 — 안 지우면 lot 삭제가 FK 로 막혀 스위트가 통째로 죽는다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM quality.inspection_result
       WHERE inspection_request_id IN (
         SELECT inspection_request_id FROM quality.inspection_request WHERE lot_id IN ${ownLots}
       )`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM quality.inspection_request WHERE lot_id IN ${ownLots}`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order_line
       WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM mdm.location
       WHERE warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE plant_id IN ${ownPlants})`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM quality.inspection_plan_version
       WHERE inspection_plan_id IN (
         SELECT inspection_plan_id FROM quality.inspection_plan
          WHERE inspection_plan_code LIKE '${PREFIX}%'
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code = '${ITEM_CODE}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code = '${SUPPLIER_CODE}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    );
    for (const id of [LOGIN_ID, NOPERM_ID, WEB_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    for (const code of [ROLE, WEB_ROLE]) {
      const role = await prisma.role.findUnique({ where: { role_code: code } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
