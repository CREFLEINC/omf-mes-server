/**
 * 피처 005 S2 읽기 전환 — 결과 불변(omf-all-around#254 · R-9·R-10·D-2).
 *
 * 새 모양(입하 줄 `lot_id` 없음 · 입하 LOT 1 = 자재 관리 LOT 2 · IQC 요청 `target_type_code=INBOUND_LOT`)은 쓰기 경로가
 * 아직 없어(S3~) 시험 준비에서 직접 넣는다. 이전 모양(마이그레이션 데이터 이전이 만드는 `PER_RECEIPT` 입하 LOT 1 :
 * 자재 관리 LOT 1)은 옛 API 로 LOT 을 만든 뒤 이전 SQL 과 같은 칸을 채운다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E005RS';
const LOGIN_ID = 'e2e-005-read-switch';
const PASSWORD = '읽기-전환-비밀번호';
const ROLE = 'E2E_005_READ_SWITCH';
const DAY = '2026-10-23';

const key = (): string => randomUUID();

interface ProgressRow {
  inboundReceiptLineId: number;
  lotId: number | null;
  lotNo: string | null;
  receivedQty: number;
  stageCode: string;
  inspection: { inspectionRequestId: number; statusCode: string; judgmentCode: string | null; judgedAt: string | null } | null;
}

interface Iqc {
  monthLots: { accepted: number; rejected: number; held: number };
  fullReinspect: { inputQty: number; restoredQty: number } | null;
  recentLots: { lotNo: string | null; counterpartName: string | null }[];
}

interface NewShape {
  lineId: bigint;
  inboundLotId: bigint;
  lotIds: bigint[];
  lotNos: string[];
  requestId: bigint;
}

describe('피처 005 S2 — 입하 LOT 읽기 전환·결과 불변 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let userId: bigint;
  const ids: Record<string, bigint> = {};
  let lineNo = 0;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('D2-1 입하 조회·입고 허브·취소 판정·계보 — 새 모양 줄의 LOT 2개', () => {
    let shape: NewShape;

    beforeAll(async () => {
      shape = await newShape([5, 5]);
    });

    it('D2-1 입고 허브(W-01-09)가 새 모양 줄을 라벨 대기가 아니라 자재 관리 LOT 두 줄로 보인다', async () => {
      const rows = (await progress()).filter((row) => row.inboundReceiptLineId === Number(shape.lineId));

      expect(rows.map((row) => row.lotNo).sort()).toEqual([...shape.lotNos].sort());
      expect(rows.every((row) => row.stageCode !== 'LABEL_PENDING' && row.receivedQty === 5)).toBe(true);
      expect(rows.map((row) => row.inspection?.inspectionRequestId)).toEqual([Number(shape.requestId), Number(shape.requestId)]);
      expect(rows[0].inspection).toMatchObject({ statusCode: 'REQUESTED', judgmentCode: null });
    });

    it('D2-1 입하 상세·줄 목록이 500 없이 줄을 보이고, 새 흐름 줄은 라벨 대기 목록에서 빠진다(FR-036 · 계약 §7)', async () => {
      const detail = await get(`/api/logistics/inbound-receipts/${String(ids.receipt)}`).expect(200);
      const line = (detail.body.lines as { inboundReceiptLineId: number; lotId: number | null }[]).find(
        (row) => row.inboundReceiptLineId === Number(shape.lineId),
      );
      expect(line?.lotId).toBe(Number(shape.lotIds[0]));

      await get(`/api/logistics/inbound-receipts/${String(ids.receipt)}/lines`).expect(200);
      // 라벨 발행 기록이 없어도 새 흐름(ON_FINALIZE) 줄은 라벨 대기가 아니다 — 자재 관리 LOT 은 발행 묶음이 라벨과 함께 세운다.
      const pending = await get('/api/logistics/inbound-receipt-lines').query({ labelIssued: 'false', q: PREFIX }).expect(200);
      const row = (pending.body.items as { inboundReceiptLineId: number }[]).find((item) => item.inboundReceiptLineId === Number(shape.lineId));
      expect(row).toBeUndefined();
    });

    it('D2-1 배정 화면·취소 판정·계보 조회가 500 없이 돈다', async () => {
      await get('/api/logistics/inbound-unallocated').query({ plantId: Number(ids.plant) }).expect(200);
      await get(`/api/logistics/inbound-receipt-lines/${String(shape.lineId)}/allocation-candidates`).expect(200);
      await get(`/api/logistics/document-progress/INBOUND_RECEIPT/${String(ids.receipt)}`).expect(200);
      for (const lotId of shape.lotIds) {
        await get(`/api/trace/lots/${String(lotId)}`).expect(200);
        await get(`/api/trace/lots/${String(lotId)}/affected-production-lots`).expect(200);
      }
    });
  });

  describe('D2-2 IQC 목록·상세·공급사 거르기·이력·인계 알림 — 「요청의 LOT 들」', () => {
    let shape: NewShape;

    beforeAll(async () => {
      shape = await newShape([4, 6]);
    });

    it('D2-2 목록이 공급사·공장·자재 관리 LOT 로 입하 LOT 요청을 찾고 상세가 200 이다', async () => {
      const ids_ = async (query: Record<string, unknown>) =>
        ((await get('/api/quality/inspection-requests').query({ inspectionTypeCode: 'IQC', size: 100, ...query }).expect(200)).body
          .items as { inspectionRequestId: number }[]).map((row) => row.inspectionRequestId);

      expect(await ids_({ supplierId: Number(ids.supplier) })).toContain(Number(shape.requestId));
      expect(await ids_({ plantId: Number(ids.plant) })).toContain(Number(shape.requestId));
      expect(await ids_({ lotId: Number(shape.lotIds[1]) })).toEqual([Number(shape.requestId)]);
      await get(`/api/quality/inspection-requests/${String(shape.requestId)}`).expect(200);
    });

    it('D2-2 이력은 입하 LOT 의 입하번호를 문서 번호로 싣는다', async () => {
      const history = await get(`/api/quality/inspection-requests/${String(shape.requestId)}/history`).expect(200);

      expect(history.body.source).toMatchObject({ targetTypeCode: 'INBOUND_LOT', documentNo: `${PREFIX}-IR` });
    });

    it('D2-2 결과 단위 불합격 확정이 LOT 전부를 옮기고 부적합 하나·LOT 마다 인계 알림 — 요청에 종합 판정이 남는다', async () => {
      const resultId = await draft(shape.requestId, 10, { rejectedQty: 10 });
      await confirm(resultId, 'REJECTED').expect(200);

      const lots = await prisma.lot.findMany({ where: { lot_id: { in: shape.lotIds } }, select: { status_code: true } });
      expect(lots.map((lot) => lot.status_code)).toEqual(['DEFECTIVE', 'DEFECTIVE']);
      const req = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: shape.requestId } });
      expect(req).toMatchObject({ status_code: 'COMPLETED', overall_judgment_code: 'REJECTED', confirmed_by: userId });
      expect(req.confirmed_at).not.toBeNull();
      const nc = await prisma.nonconformance.findFirstOrThrow({
        where: { inspection_result_id: BigInt(resultId) },
        select: { inspection_request_id: true, nonconformance_lot: { select: { lot_id: true, affected_qty: true } } },
      });
      expect(nc.inspection_request_id).toBe(shape.requestId);
      expect(nc.nonconformance_lot.map((row) => [row.lot_id, row.affected_qty.toNumber()])).toEqual([
        [shape.lotIds[0], 4],
        [shape.lotIds[1], 6],
      ]);
      const events = await prisma.notification_event.findMany({
        where: { event_type_code: 'IQC_INSPECTION_REJECTED', aggregate_type_code: 'LOT', aggregate_id: { in: shape.lotIds } },
        select: { payload: true },
      });
      expect(events).toHaveLength(2);
      expect(events.map((event) => (event.payload as { receipt_no?: string; supplier?: string }).receipt_no)).toEqual([
        `${PREFIX}-IR`,
        `${PREFIX}-IR`,
      ]);
    });
  });

  describe('D2-3 대시보드 IQC·W-03-05 — 새 모양은 요청 종합 판정·확정 주기', () => {
    let rejected: NewShape;
    let rechecked: NewShape;
    let rechecks: bigint[];
    let before: Iqc;

    beforeAll(async () => {
      // 앞 묶음의 판정도 같은 공장에 있다 — 늘어난 만큼만 본다.
      before = await iqcBlock();
      rejected = await newShape([3]);
      await confirm(await draft(rejected.requestId, 3, { rejectedQty: 3 }), 'REJECTED').expect(200);
      // 확정 취소 뒤 재검사(주기 2)로 합격한 요청 — 확정 취소 경로는 S9 라 결과를 직접 둔다.
      rechecked = await newShape([8]);
      rechecks = [
        await confirmedResult(rechecked.requestId, 1, 1, 'REJECTED', 8),
        await confirmedResult(rechecked.requestId, 2, 2, 'ACCEPTED', 8),
      ];
      await prisma.inspection_request.update({
        where: { inspection_request_id: rechecked.requestId },
        data: {
          status_code: 'COMPLETED', confirm_cycle: 2, overall_judgment_code: 'ACCEPTED',
          confirmed_at: new Date(`${DAY}T04:00:00.000Z`), confirmed_by: userId,
        },
      });
    });

    it('D2-3 대시보드 IQC 최종 판정은 요청 종합 판정, 「재검 투입·OK 복원」은 확정 주기 2 이상 결과다', async () => {
      const iqc = await iqcBlock();

      expect(iqc.monthLots).toMatchObject({ accepted: before.monthLots.accepted + 1, rejected: before.monthLots.rejected + 1 });
      expect(iqc.fullReinspect).toEqual({
        inputQty: (before.fullReinspect?.inputQty ?? 0) + 8,
        restoredQty: (before.fullReinspect?.restoredQty ?? 0) + 8,
      });
      expect(iqc.recentLots).toEqual(
        expect.arrayContaining([expect.objectContaining({ lotNo: rejected.lotNos[0], counterpartName: `${PREFIX}-SUP` })]),
      );
    });

    it('D2-3 W-03-05 「최종 회차만」은 입하 LOT 요청의 마지막 주기 결과다', async () => {
      const final = await get('/api/quality/inspection-results').query({
        finalRoundOnly: 'true', itemId: Number(ids.item), inspectedFrom: '2026-01-01T00:00:00Z', inspectedTo: '2026-12-31T23:59:59Z', size: 100,
      }).expect(200);
      const mine = (final.body.items as { inspectionResultId: number; inspectionRequestId: number }[]).filter(
        (row) => row.inspectionRequestId === Number(rechecked.requestId),
      );

      expect(mine.map((row) => row.inspectionResultId)).toEqual([Number(rechecks[1])]);
    });
  });

  describe('SC-008·R18-1 이전 모양 — 옛 결과 그대로, 진행 중 IQC 를 이어 확정', () => {
    it('SC-008 이전 모양·옛 LOT 은 입고 허브에서 S2 전과 같은 줄 하나다', async () => {
      const migrated = await oldShape(7, true);
      const legacy = await oldShape(2, false);

      for (const lot of [migrated, legacy]) {
        const rows = (await progress()).filter((row) => row.inboundReceiptLineId === Number(lot.lineId));
        expect(rows).toEqual([
          expect.objectContaining({
            lotId: lot.lotId,
            stageCode: 'INSPECTION_REQUESTED',
            inspection: expect.objectContaining({ inspectionRequestId: lot.requestId, statusCode: 'REQUESTED', judgmentCode: null }),
          }),
        ]);
      }
      const detail = await get(`/api/logistics/inbound-receipts/${String(ids.receipt)}`).expect(200);
      expect(
        (detail.body.lines as { inboundReceiptLineId: number; lotId: number | null }[]).find(
          (row) => row.inboundReceiptLineId === Number(migrated.lineId),
        )?.lotId,
      ).toBe(migrated.lotId);
      const history = await get(`/api/quality/inspection-requests/${migrated.requestId}/history`).expect(200);
      expect(history.body.source).toMatchObject({ targetTypeCode: 'LOT', documentNo: `${PREFIX}-IR` });
    });

    it('R18-1 이전된 진행 중 IQC 를 결과 단위로 확정하면 요청 종합 판정·확정 시각·사람이 채워진다(CHECK 위반 없음)', async () => {
      const migrated = await oldShape(5, true);

      await confirm(await draft(BigInt(migrated.requestId), 5), 'ACCEPTED').expect(200);

      const req = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(migrated.requestId) } });
      expect(req).toMatchObject({ status_code: 'COMPLETED', overall_judgment_code: 'ACCEPTED', confirmed_by: userId });
      expect(req.confirmed_at).not.toBeNull();
      const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(migrated.lotId) } });
      expect(lot.status_code).toBe('NORMAL');
      const row = (await progress()).find((item) => item.lotId === migrated.lotId);
      expect(row?.inspection).toMatchObject({ statusCode: 'COMPLETED', judgmentCode: 'ACCEPTED' });
    });

    it('R18-1 입하 LOT 이 없는 옛 요청은 지금처럼 상태만 바뀐다 — 요청 칸은 비어 있다', async () => {
      const legacy = await oldShape(3, false);

      await confirm(await draft(BigInt(legacy.requestId), 3), 'ACCEPTED').expect(200);

      const req = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(legacy.requestId) } });
      expect(req).toMatchObject({ status_code: 'COMPLETED', overall_judgment_code: null, confirmed_at: null });
    });
  });

  // ─────────────────────────────── 준비 ───────────────────────────────

  async function iqcBlock(): Promise<Iqc> {
    const body = (await get('/api/app/dashboard-summary').query({ baseDate: DAY, plantId: Number(ids.plant) }).expect(200)).body as {
      quality: { iqc: Iqc };
    };
    return body.quality.iqc;
  }

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  async function progress(): Promise<ProgressRow[]> {
    return (await get(`/api/logistics/purchase-orders/${String(ids.order)}/inbound-progress`).expect(200)).body.items as ProgressRow[];
  }

  async function inboundLine(qty: number, lotless: boolean): Promise<bigint> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: ids.receipt, line_no: lineNo, item_id: ids.item, purchase_order_line_id: lotless ? null : ids.orderLine,
        received_qty: qty, uom_id: ids.uom, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED',
      },
    });
    await prisma.inbound_receipt_po_allocation.create({
      data: { inbound_receipt_line_id: line.inbound_receipt_line_id, purchase_order_line_id: ids.orderLine, allocated_qty: qty },
    });
    return line.inbound_receipt_line_id;
  }

  /** 새 흐름이 만들 모양 — 입하 줄 `lot_id` 없음, 입하 LOT(마감됨)과 자재 관리 LOT 들, 입하 LOT 단위 IQC 요청. */
  async function newShape(qtys: number[]): Promise<NewShape> {
    const total = qtys.reduce((sum, qty) => sum + qty, 0);
    const lineId = await inboundLine(total, true);
    seq += 1;
    const inboundLot = await prisma.inbound_lot.create({
      data: {
        inbound_lot_no: `IL-${PREFIX}-${seq}`, plant_id: ids.plant, item_id: ids.item, supplier_id: ids.supplier, uom_id: ids.uom,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`),
        received_closed_at: new Date(`${DAY}T01:30:00.000Z`), erp_send_mode_code: 'ON_FINALIZE', inbound_receipt_line_id: lineId,
      },
    });
    const lotIds: bigint[] = [];
    const lotNos: string[] = [];
    for (const [index, qty] of qtys.entries()) {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-N${seq}-${index}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty,
          uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: lineId, status_code: 'INSPECTION_PENDING',
          lifecycle_status_code: 'ACTIVE', inbound_lot_id: inboundLot.inbound_lot_id,
        },
      });
      await prisma.lot_hold.create({
        data: {
          lot_id: lot.lot_id, reason_code: 'INCOMING_INSPECTION_WAIT', status_code: 'HELD', held_at: new Date(`${DAY}T01:30:00.000Z`),
          target_lot_status_code: 'INSPECTION_PENDING', held_worker_id: ids.worker,
        },
      });
      lotIds.push(lot.lot_id);
      lotNos.push(lot.lot_no);
    }
    const req = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IRQ-${seq}`, inspection_type_code: 'IQC', target_type_code: 'INBOUND_LOT',
        target_id: inboundLot.inbound_lot_id, inbound_lot_id: inboundLot.inbound_lot_id, item_id: ids.item, target_qty: total,
        uom_id: ids.uom, status_code: 'REQUESTED', requested_at: new Date(`${DAY}T01:30:00.000Z`),
      },
    });
    return { lineId, inboundLotId: inboundLot.inbound_lot_id, lotIds, lotNos, requestId: req.inspection_request_id };
  }

  /**
   * 옛 경로(`POST /trace/lots` — 이제 닫힘 · FR-036)가 쓰던 모양 그대로 LOT·IQC 요청을 넣는다: 검사 대기 LOT + 수입검사 대기 보류 +
   * LOT 단위 IQC 요청 + 줄 `lot_id`. `migrated` 면 마이그레이션 데이터 이전과 같은 칸을 채운다.
   */
  async function oldShape(qty: number, migrated: boolean) {
    const lineId = await inboundLine(qty, false);
    seq += 1;
    const at = new Date(`${DAY}T02:00:00.000Z`);
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-O${seq}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty, uom_id: ids.uom,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: lineId, status_code: 'INSPECTION_PENDING', created_by: userId,
      },
    });
    const lotId = Number(lot.lot_id);
    await prisma.lot_hold.create({
      data: {
        lot_id: lot.lot_id, reason_code: 'INCOMING_INSPECTION_WAIT', status_code: 'HELD', target_lot_status_code: 'INSPECTION_PENDING',
        held_by: userId, held_at: at, created_by: userId,
      },
    });
    const req = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IQC-${seq}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lot.lot_id,
        item_id: ids.item, lot_id: lot.lot_id, target_qty: qty, uom_id: ids.uom, status_code: 'REQUESTED', requested_at: at, created_by: userId,
      },
      select: { inspection_request_id: true },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: lineId }, data: { lot_id: lot.lot_id } });
    if (migrated) {
      const inboundLot = await prisma.inbound_lot.create({
        data: {
          inbound_lot_no: `IL-MIG-${String(lineId)}`, plant_id: ids.plant, item_id: ids.item, supplier_id: ids.supplier, uom_id: ids.uom,
          status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: new Date(`${DAY}T01:00:00.000Z`),
          erp_send_mode_code: 'PER_RECEIPT', inbound_receipt_line_id: lineId,
        },
      });
      await prisma.lot.update({ where: { lot_id: BigInt(lotId) }, data: { inbound_lot_id: inboundLot.inbound_lot_id } });
      await prisma.inspection_request.update({
        where: { inspection_request_id: req.inspection_request_id },
        data: { inbound_lot_id: inboundLot.inbound_lot_id },
      });
    }
    return { lineId, lotId, requestId: Number(req.inspection_request_id) };
  }

  async function draft(requestId: bigint, qty: number, split: { rejectedQty?: number } = {}): Promise<number> {
    const rejectedQty = split.rejectedQty ?? 0;
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionRequestId: Number(requestId), inspectedQty: qty, acceptedQty: qty - rejectedQty, rejectedQty, heldQty: 0,
        uomId: Number(ids.uom), inspectedAt: `${DAY}T03:00:00.000Z`, statusCode: 'DRAFT',
      })
      .expect(201);
    return response.body.inspectionResultId as number;
  }

  function confirm(resultId: number, judgment: string): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/inspection-results/${resultId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', 'W/"1"')
      .send({ overallJudgmentCode: judgment, ...(judgment === 'REJECTED' ? { judgmentChangeReason: '시험' } : {}) });
  }

  async function confirmedResult(requestId: bigint, round: number, cycle: number, judgment: string, qty: number): Promise<bigint> {
    seq += 1;
    const accepted = judgment === 'ACCEPTED' ? qty : 0;
    const created = await prisma.inspection_result.create({
      data: {
        inspection_result_no: `${PREFIX}-IRS-${seq}`, inspection_request_id: requestId, inspection_round: round, confirm_cycle: cycle,
        inspected_qty: qty, accepted_qty: accepted, rejected_qty: qty - accepted, uom_id: ids.uom, overall_judgment_code: judgment,
        inspector_id: ids.worker, inspected_at: new Date(`${DAY}T0${round + 2}:00:00.000Z`),
        confirmed_at: new Date(`${DAY}T0${round + 2}:30:00.000Z`), status_code: 'CONFIRMED', idempotency_key: `${PREFIX}-${seq}`,
      },
    });
    return created.inspection_result_id;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '읽기전환법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '읽기전환사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '읽기전환공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: {
        item_code: `${PREFIX}-ITEM`, item_name: '읽기전환자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom,
        lot_controlled: true, inspection_required: true,
      },
    })).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP`, partner_name: `${PREFIX}-SUP` } })).partner_id;
    ids.order = (await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO`, supplier_id: ids.supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    })).purchase_order_id;
    ids.orderLine = (await prisma.purchase_order_line.create({
      data: { purchase_order_id: ids.order, line_no: 1, item_id: ids.item, ordered_qty: 1000, uom_id: ids.uom },
    })).purchase_order_line_id;
    ids.receipt = (await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`, supplier_id: ids.supplier, plant_id: ids.plant,
        receipt_datetime: new Date(`${DAY}T01:00:00.000Z`), status_code: 'REGISTERED',
      },
    })).inbound_receipt_id;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '읽기전환', status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '읽기전환용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission) => ({ role_id: role.role_id, permission_code: permission.code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    ids.worker = (await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`, worker_name: '읽기전환검사자', business_unit_id: ids.unit, plant_id: ids.plant,
        app_user_id: user.app_user_id, status_code: 'EMPLOYED',
      },
    })).worker_id;
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN
      (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`;
    const results = `SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`;
    const ncs = `SELECT nonconformance_id FROM quality.nonconformance WHERE inspection_result_id IN (${results})`;
    for (const sql of [
      `DELETE FROM app.notification_event WHERE aggregate_type_code = 'LOT' AND aggregate_id IN (${lots})`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.defect_record WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.item_inspection_level_history WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id
         FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt
         WHERE inbound_receipt_no LIKE '${PREFIX}%'))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt
         WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order
         WHERE purchase_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
