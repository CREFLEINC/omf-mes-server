/**
 * IQC 불합격 → 처분(재작업) → 재검사 → 입고 (e2e · omf-all-around#106).
 *
 * 실제 API 로 잇는다 — LOT 등록(P-01-01) · 판정(W-01-01) · 처분(W-03-10) · 입고(W-01-10).
 *
 * 걸리는 규칙: #100(합격 전 입고 차단 · 불합격은 불량창고로만) · #106(불합격 사유 필수 · 부적합 자동 등록 P-41 ·
 * 재작업이 의뢰를 다시 연다 P-43 · 처분 전 재검사 차단) · #121(확정이 사유를 갈아 끼운다 P-47) · #122(임시 저장이 사유를 남긴다 P-48).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRoute } from './approval-request.fixture';

const LOGIN_ID = 'e2e-iqc-flow';
const PASSWORD = 'IQC-흐름-비밀번호';
const PREFIX = 'IQCFLOW';
const ITEM_CODE = 'IQCFLOW-ITEM';
const SUPPLIER_CODE = 'IQCFLOW-SUP';
const DEFECT_CODE = 'IQCFLOW-DEF';
const ROLE = 'E2E_IQC_FLOW';
// W-CO-06 — 단말 토큰 발급(#122 리뷰 m3 의 단말 PUT 케이스). W-04-11 — 재고 재등록(#108 리뷰 M1).
const PERMISSIONS = ['P-01-01', 'W-01-01', 'W-03-10', 'W-01-10', 'W-CO-06', 'W-04-11'];
const DAY = '2026-10-16';
// 특채(#84 · 장부 P-79) — 요청·적용은 W-03-10, 결재는 W-03-09 를 가진 «다른» 계정이 한다.
const APPROVER_LOGIN_ID = 'e2e-iqc-flow-approver';
const APPROVER_ROLE = 'E2E_IQC_FLOW_APPROVER';

const key = (): string => randomUUID();

describe('IQC 불합격 → 처분 → 입고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let approverCookie: string[];
  let approverUserId: bigint;
  let plantId: number;
  let itemId: number;
  let uomId: number;
  let warehouseId: number;
  let locationId: number;
  let defectWarehouseId: number;
  let defectLocationId: number;
  let defectCodeId: number;
  let inboundReceiptId: bigint;
  let lineNo = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
    await makeApprover();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 합격 전에는 입고되지 않는다(#100) — 불합격은 사유가 있어야 확정되고(#106) 부적합이 선다(P-41)', async () => {
    const { lotId, lineId, requestId } = await registerIqcLot(10);
    await receive(lotId, lineId, 10).expect(400);

    const resultId = await draft(requestId, { acceptedQty: 0, rejectedQty: 10 });
    await confirm(resultId, 'REJECTED').expect(400);
    await recordReason(resultId);
    await confirm(resultId, 'REJECTED').expect(200);

    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
    const nc = await openNonconformance(lotId);
    expect(nc).toMatchObject({ status_code: 'PENDING_DECISION', inspection_result_id: BigInt(resultId) });
    await receive(lotId, lineId, 10).expect(400);
  });

  it('⭐ 불합격 LOT 은 불량창고로만 입고된다(#100 · P-45) — 일반 창고는 계속 거부', async () => {
    const { lotId, lineId } = await rejectedLot(10);

    const rejected = await receive(lotId, lineId, 10).expect(400);
    expect(JSON.stringify(rejected.body)).toContain('불량창고로만');
    await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
  });

  it('⭐ 경로 ① 처분 정상 → 보류 해제 → 입고', async () => {
    const { lotId, lineId } = await rejectedLot(10);
    const nc = await openNonconformance(lotId);

    await decide(nc.nonconformance_id, { dispositionTypeCode: 'NORMAL', decisionQty: 10 }).expect(201);

    expect(await lotStatus(lotId)).toBe('NORMAL');
    expect(await openInspectionHolds(lotId)).toBe(0);
    await receive(lotId, lineId, 10).expect(201);
  });

  it('⭐ 경로 ② 선별 → 양품분(원 LOT) 정상·보류 해제 → 양품 수량 입고 · 불량분은 새 LOT 불량', async () => {
    const { lotId, lineId } = await rejectedLot(10);
    const nc = await openNonconformance(lotId);

    await decide(nc.nonconformance_id, {
      dispositionTypeCode: 'SORT',
      decisionQty: 10,
      acceptedQty: 7,
      rejectedQty: 3,
      businessDate: DAY,
    }).expect(201);

    expect(await lotStatus(lotId)).toBe('NORMAL');
    expect(await openInspectionHolds(lotId)).toBe(0);
    const children = await prisma.lot_relation.findMany({ where: { source_lot_id: BigInt(lotId) }, select: { target_lot_id: true } });
    expect(children).toHaveLength(1);
    const childLotId = Number(children[0].target_lot_id);
    expect(await lotStatus(childLotId)).toBe('DEFECTIVE');

    // 장부 P-56 — 입고 화면은 입고 가능 수량(양품 7)과 선별 불량분(-S1 3)을 받는다.
    const lines = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${String(inboundReceiptId)}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    const line = (lines.body.items as { inboundReceiptLineId: number; receivableQty: number; splitLots: unknown[] }[])
      .find((row) => row.inboundReceiptLineId === lineId);
    expect(line).toMatchObject({
      receivableQty: 7,
      splitLots: [expect.objectContaining({ lotId: childLotId, statusCode: 'DEFECTIVE', receivableQty: 3 })],
    });

    // ⛔ 입하 수량(10)으로는 입고되지 않는다 — 떼어 낸 불량분 3 이 빠진다.
    await receive(lotId, lineId, 10).expect(400);
    await receive(lotId, lineId, 7).expect(201);
    await receive(lotId, lineId, 1).expect(400);
    // 선별 불량분은 조상의 입하 라인을 따라 불량창고로만 입고된다(P-45).
    await receive(childLotId, lineId, 3).expect(400);
    await receive(childLotId, lineId, 3, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
  });

  /* #108 리뷰 C1 — 불량창고에 입고한 «뒤» 선별하면 불량분 재고는 원장 이동으로 생긴다. 입고 화면이 다시 입고하게 두지 않는다. */
  it('⭐ 경로 ②-b 불량창고 입고 → 선별 → 원 LOT·불량분 모두 입고 가능 0 · 재입고 400', async () => {
    const { lotId, lineId } = await rejectedLot(10);
    await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
    const nc = await openNonconformance(lotId);

    await decide(nc.nonconformance_id, {
      dispositionTypeCode: 'SORT',
      decisionQty: 10,
      acceptedQty: 7,
      rejectedQty: 3,
      businessDate: DAY,
    }).expect(201);

    const children = await prisma.lot_relation.findMany({ where: { source_lot_id: BigInt(lotId) }, select: { target_lot_id: true } });
    expect(children).toHaveLength(1);
    const childLotId = Number(children[0].target_lot_id);
    // 불량분 3 은 같은 불량창고 위치로 이미 옮겨져 있다.
    const childStock = await prisma.inventory_balance.aggregate({ where: { lot_id: BigInt(childLotId) }, _sum: { on_hand_qty: true } });
    expect(Number(childStock._sum.on_hand_qty)).toBe(3);

    const lines = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${String(inboundReceiptId)}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    const line = (lines.body.items as { inboundReceiptLineId: number; receivableQty: number; splitLots: unknown[] }[])
      .find((row) => row.inboundReceiptLineId === lineId);
    expect(line).toMatchObject({
      receivableQty: 0,
      splitLots: [expect.objectContaining({ lotId: childLotId, receivableQty: 0 })],
    });

    await receive(childLotId, lineId, 3, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(400);
    await receive(lotId, lineId, 1, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(400);
    const total = await prisma.inventory_balance.aggregate({
      where: { lot_id: { in: [BigInt(lotId), BigInt(childLotId)] } }, _sum: { on_hand_qty: true },
    });
    expect(Number(total._sum.on_hand_qty)).toBe(10);
  });

  /* #108 리뷰 M1 · 담당자 결정 (a) — 불량창고에 이미 입고된 LOT 은 처분 정상이 보류를 닫지 않는다. 재고 재등록(W-04-11)이 닫으며 옮긴다. */
  it('⭐ 경로 ①-b 불량창고 입고 → 처분 정상 → 수입검사 대기 보류 유지 → 재고 재등록이 보류를 닫고 일반 창고로 옮긴다', async () => {
    const { lotId, lineId } = await rejectedLot(10);
    await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
    const nc = await openNonconformance(lotId);

    const decided = await decide(nc.nonconformance_id, { dispositionTypeCode: 'NORMAL', decisionQty: 10 }).expect(201);

    expect(await lotStatus(lotId)).toBe('NORMAL');
    expect(await openInspectionHolds(lotId)).toBe(1);

    const hold = await prisma.lot_hold.findFirstOrThrow({
      where: { lot_id: BigInt(lotId), reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null },
      select: { lot_hold_id: true },
    });
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) }, select: { version_no: true } });
    await request(app.getHttpServer())
      .post('/api/logistics/stock-reinstatements')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        dispositionDecisionId: decided.body.dispositionDecisionId as number,
        lot: { lotId, versionNo: lot.version_no },
        lotHoldId: Number(hold.lot_hold_id),
        toWarehouseId: warehouseId,
        toLocationId: locationId,
        qty: 10,
        uomId,
        releaseReasonCode: 'RETEST_PASS',
        reasonCode: null,
        businessDate: DAY,
        // ⚠ 해제 시각(released_at)이 된다 — 입하 때 지금 시각으로 선 보류보다 앞서면 ck_lot_hold_release 에 걸린다.
        occurredAt: new Date().toISOString(),
      })
      .expect(201);

    expect(await openInspectionHolds(lotId)).toBe(0);
    const general = await prisma.inventory_balance.aggregate({
      where: { lot_id: BigInt(lotId), warehouse_id: BigInt(warehouseId) }, _sum: { on_hand_qty: true },
    });
    expect(Number(general._sum.on_hand_qty)).toBe(10);
  });

  it('⭐ 재작업 → 검사 대기(보류 유지) → 재검 회차 합격 → 보류 해제 → 입고', async () => {
    const { lotId, lineId, requestId, resultId } = await rejectedLot(10);
    const nc = await openNonconformance(lotId);

    expect(await requestStatus(requestId)).toBe('COMPLETED');
    await decide(nc.nonconformance_id, { dispositionTypeCode: 'REWORK', decisionQty: 10 }).expect(201);
    expect(await lotStatus(lotId)).toBe('INSPECTION_PENDING');
    expect(await openInspectionHolds(lotId)).toBe(1);
    await receive(lotId, lineId, 10).expect(400);
    // 재작업이 IQC 의뢰를 다시 연다 — 판정 화면 대기 큐에 다시 떠야 재검사를 시작한다(장부 P-43 · 3단계 검증).
    expect(await requestStatus(requestId)).toBe('IN_PROGRESS');
    expect(await pendingQueueIds()).toContain(requestId);

    const second = await draft(requestId, { acceptedQty: 10, rejectedQty: 0, previousResultId: resultId });
    expect(await requestStatus(requestId)).toBe('IN_PROGRESS');
    await confirm(second, 'ACCEPTED').expect(200);
    expect(await requestStatus(requestId)).toBe('COMPLETED');

    expect(await lotStatus(lotId)).toBe('NORMAL');
    expect(await openInspectionHolds(lotId)).toBe(0);
    await receive(lotId, lineId, 10).expect(201);
  });

  /* #121 · 장부 P-47 — 사유를 `:confirm` 에 실으면 확정과 한 트랜잭션에서 그 회차의 기록을 갈아 끼운다. */
  it('⭐ 불합격 확정 재시도에도 그 회차의 사유는 확정 시점 입력 1벌이다', async () => {
    const { requestId } = await registerIqcLot(10);
    const resultId = await draft(requestId, { acceptedQty: 0, rejectedQty: 10 });
    const reason = (description: string) => ({ overallJudgmentCode: 'REJECTED', defects: [{ defectCodeId, defectQty: 10, defectDescription: description }] });

    // 옛 화면이 먼저 남긴 기록 + 확정 실패(버전 어긋남) — 실패한 확정은 기록을 바꾸지 않는다.
    await recordReason(resultId);
    await confirmWith(resultId, reason('처음 사유'), 9).expect(409);
    expect(await reasonsOf(resultId)).toEqual(['외관 긁힘']);

    await confirmWith(resultId, reason('고친 사유'), 1).expect(200);
    expect(await reasonsOf(resultId)).toEqual(['고친 사유']);
    // 자동으로 서는 부적합(P-41)도 갈아 끼운 사유를 읽는다.
    const nc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_result_id: BigInt(resultId) }, select: { description: true } });
    expect(nc.description).toContain('고친 사유');
    expect(nc.description).not.toContain('외관 긁힘');
  });

  it('⭐ 불합격 사유를 남긴 뒤 합격으로 확정하면 그 회차의 불량 기록이 지워진다 · 합격에 사유를 실으면 400', async () => {
    const { lotId, requestId } = await registerIqcLot(10);
    const resultId = await draft(requestId, { acceptedQty: 10, rejectedQty: 0 });
    await recordReason(resultId);

    const invalid = await confirmWith(resultId, { overallJudgmentCode: 'ACCEPTED', defects: [{ defectCodeId, defectQty: 1 }] }, 1).expect(400);
    expect(JSON.stringify(invalid.body)).toContain('defects');
    await confirm(resultId, 'ACCEPTED').expect(200);

    expect(await reasonsOf(resultId)).toEqual([]);
    expect(await lotStatus(lotId)).toBe('NORMAL');
  });

  /* #122 · 장부 P-48 — 임시 저장이 사유를 그 회차의 불량 기록으로 갈아 끼우고, 확정 전 기록은 집계·기간 목록에 안 잡힌다. */
  it('⭐ 임시 저장한 불합격 사유가 다시 읽히고, 사유 없이 확정하면 그 사유로 확정된다', async () => {
    const { lotId, requestId } = await registerIqcLot(10);
    const created = await request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionRequestId: requestId, inspectedQty: 10, acceptedQty: 0, rejectedQty: 10, heldQty: 0, uomId,
        inspectedAt: `${DAY}T03:00:00.000Z`, statusCode: 'DRAFT', overallJudgmentCode: 'REJECTED',
        defects: [{ defectCodeId, defectQty: 10, defectDescription: '처음 사유' }],
      })
      .expect(201);
    const resultId = created.body.inspectionResultId as number;
    expect(await reasonsOf(resultId)).toEqual(['처음 사유']);

    await saveDraft(resultId, 1, { defects: [{ defectCodeId, defectQty: 10, defectDescription: '고친 사유' }] }).expect(200);
    expect(await reasonsOf(resultId)).toEqual(['고친 사유']);
    // 한 결과로 좁히면 작성중 사유도 돌려준다(화면 복원) · 기간 목록에는 아직 없다.
    expect(await listedReasons({ inspectionResultId: resultId })).toEqual(['고친 사유']);
    expect(await listedReasons({ lotId })).toEqual([]);

    await confirmWith(resultId, { overallJudgmentCode: 'REJECTED' }, 2).expect(200);
    expect(await reasonsOf(resultId)).toEqual(['고친 사유']);
    expect(await listedReasons({ lotId })).toEqual(['고친 사유']);
  });

  it('⭐ 합격으로 바꿔 임시 저장하면 사유가 지워지고, 합격 작성중에 사유를 실으면 400', async () => {
    const { requestId } = await registerIqcLot(10);
    const resultId = await draft(requestId, { acceptedQty: 10, rejectedQty: 0 });
    const reason = [{ defectCodeId, defectQty: 1, defectDescription: '사유' }];

    await saveDraft(resultId, 1, { overallJudgmentCode: 'REJECTED', defects: reason }).expect(200);
    expect(await reasonsOf(resultId)).toEqual(['사유']);
    const invalid = await saveDraft(resultId, 2, { overallJudgmentCode: 'ACCEPTED', defects: reason }).expect(400);
    expect(JSON.stringify(invalid.body)).toContain('defects');

    await saveDraft(resultId, 2, { overallJudgmentCode: 'ACCEPTED', defects: [] }).expect(200);
    expect(await reasonsOf(resultId)).toEqual([]);
  });

  /* #122 리뷰 m3 — 단말에서 온 계정 저장(Bearer 단말 토큰 + 세션)도 불량 기록의 귀속 작업자를 POST 처럼 푼다. */
  it('⭐ 단말 토큰을 함께 실은 임시 저장의 사유도 귀속 작업자가 남는다', async () => {
    const { requestId } = await registerIqcLot(10);
    const resultId = await draft(requestId, { acceptedQty: 0, rejectedQty: 10 });
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T1`, plant_id: BigInt(plantId), terminal_type_code: 'POP', status_code: 'RUNNING' },
    });
    const issued = await request(app.getHttpServer())
      .post(`/api/mdm/terminals/${Number(terminal.terminal_id)}:issue-token`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(201);

    await saveDraft(
      resultId,
      1,
      { overallJudgmentCode: 'REJECTED', defects: [{ defectCodeId, defectQty: 10, defectDescription: '단말 사유' }] },
      { Authorization: `Bearer ${issued.body.token as string}` },
    ).expect(200);

    const worker = await prisma.worker.findUniqueOrThrow({ where: { worker_no: `${PREFIX}-W1` }, select: { worker_id: true } });
    const rows = await prisma.defect_record.findMany({
      where: { inspection_result_id: BigInt(resultId) },
      select: { defect_description: true, worker_id: true },
    });
    expect(rows).toEqual([{ defect_description: '단말 사유', worker_id: worker.worker_id }]);
  });

  /* #106 · 3단계 검증 — 처분(재작업) 없이 불합격 LOT 을 재검사하지 못한다. 작성중·확정 어느 쪽으로도 회차가 생기지 않는다. */
  it('⛔ 처분 전 불합격 LOT 에는 재검사 회차를 만들 수 없다 — LOT 은 불량 그대로, 의뢰도 완료 그대로', async () => {
    const { lotId, requestId, resultId } = await rejectedLot(10);
    const reinspect = (statusCode: 'DRAFT' | 'CONFIRMED') =>
      request(app.getHttpServer())
        .post('/api/quality/inspection-results')
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .send({
          inspectionRequestId: requestId, inspectedQty: 10, acceptedQty: 10, rejectedQty: 0, heldQty: 0,
          uomId, inspectedAt: `${DAY}T04:00:00.000Z`, statusCode, previousResultId: resultId,
          ...(statusCode === 'CONFIRMED' ? { overallJudgmentCode: 'ACCEPTED' } : {}),
        });

    const drafted = await reinspect('DRAFT').expect(400);
    expect(JSON.stringify(drafted.body)).toContain('처분 판정(재작업) 뒤에');
    await reinspect('CONFIRMED').expect(400);

    expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(requestId) } })).toBe(1);
    expect(await requestStatus(requestId)).toBe('COMPLETED');
    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  describe('특채 — 요청 → 결재(W-03-09) → 적용(W-03-10) (#84 · 장부 P-79)', () => {
    it('⭐ 승인 뒤 적용하면 LOT 정상(C25)·수입검사 보류 해제·처분 «특채» 기록 · 승인자·일시·사유·사용 가능 수량이 조회된다', async () => {
      const { lotId, lineId } = await rejectedLot(10);
      const nc = await openNonconformance(lotId);

      const created = await requestConcession(nc.nonconformance_id, lotId, 6, '외관 경미 — 조건부 사용').expect(201);
      expect(created.body).toMatchObject({ statusCode: 'PENDING', approvedQty: 6, remarks: '외관 경미 — 조건부 사용' });
      const concessionId = created.body.concessionId as number;
      const approvalRequestId = created.body.approvalRequestId as number;

      // ⛔ 결재 전 적용은 400 — LOT 은 불량 그대로다.
      const early = await applyConcession(concessionId).expect(400);
      expect(JSON.stringify(early.body)).toContain('APPROVAL_IN_PROGRESS');
      expect(await lotStatus(lotId)).toBe('DEFECTIVE');

      await decideApproval(approvalRequestId, 'approve');
      const applied = await applyConcession(concessionId).expect(200);
      expect(applied.body).toMatchObject({ statusCode: 'APPROVED', approvedQty: 6, usable: true });

      expect(await lotStatus(lotId)).toBe('NORMAL');
      expect(await openInspectionHolds(lotId)).toBe(0);
      const decisions = await prisma.disposition_decision.findMany({ where: { nonconformance_id: nc.nonconformance_id } });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ disposition_type_code: 'CONCESSION', approval_request_id: BigInt(approvalRequestId) });
      expect(decisions[0].decision_qty.toNumber()).toBe(6);

      // 승인자·승인 일시는 결재 상세(W-03-09 화면), 사유·사용 가능 수량은 특채 상세가 낸다.
      const approval = await request(app.getHttpServer()).get(`/api/app/approval-requests/${approvalRequestId}`).set('Cookie', approverCookie).expect(200);
      expect(approval.body.request).toMatchObject({ statusCode: 'APPROVED', approvalTypeCode: 'CONCESSION', reason: '외관 경미 — 조건부 사용' });
      expect(approval.body.steps[0]).toMatchObject({ approverId: Number(approverUserId), decisionCode: 'APPROVED' });
      expect(approval.body.steps[0].decisionAt).toEqual(expect.any(String));
      const detail = await request(app.getHttpServer()).get(`/api/quality/concessions/${concessionId}`).set('Cookie', cookie).expect(200);
      expect(detail.body).toMatchObject({ approvedQty: 6, consumedQty: 0, remarks: '외관 경미 — 조건부 사용', lotId });

      // 특채 LOT 은 일반 창고로 입고된다(정상).
      await receive(lotId, lineId, 10).expect(201);
    });

    it('⛔ 반려면 적용이 특채를 REJECTED 로 닫고 LOT 은 불량 그대로다', async () => {
      const { lotId } = await rejectedLot(10);
      const nc = await openNonconformance(lotId);
      const created = await requestConcession(nc.nonconformance_id, lotId, 10, '반려 경계').expect(201);

      await decideApproval(created.body.approvalRequestId as number, 'reject');
      const applied = await applyConcession(created.body.concessionId as number).expect(200);

      expect(applied.body).toMatchObject({ statusCode: 'REJECTED', usable: false });
      expect(await lotStatus(lotId)).toBe('DEFECTIVE');
      expect(await openInspectionHolds(lotId)).toBe(1);
      expect(await prisma.disposition_decision.count({ where: { nonconformance_id: nc.nonconformance_id } })).toBe(0);
    });

    it('⭐ 불량창고 재고가 남은 LOT 도 특채 적용이 보류를 닫는다(담당자 결정 2026-10-20 「현행 유지」)', async () => {
      const { lotId, lineId } = await rejectedLot(10);
      await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
      const nc = await openNonconformance(lotId);
      const created = await requestConcession(nc.nonconformance_id, lotId, 10, '불량창고 재고 특채').expect(201);

      await decideApproval(created.body.approvalRequestId as number, 'approve');
      await applyConcession(created.body.concessionId as number).expect(200);

      expect(await lotStatus(lotId)).toBe('NORMAL');
      expect(await openInspectionHolds(lotId)).toBe(0);
    });

    it('⛔ 요청 뒤 다른 처분이 수량을 먼저 쓰면 적용이 400(approvedQty)이고 특채·LOT·판정은 그대로다', async () => {
      const { lotId } = await rejectedLot(10);
      const nc = await openNonconformance(lotId);
      const created = await requestConcession(nc.nonconformance_id, lotId, 6, '적용 전 처분 선행').expect(201);
      await decideApproval(created.body.approvalRequestId as number, 'approve');

      // 처분 정상 6 이 먼저 확정됐다 — 남은 수량 4 < 승인 6.
      await decide(nc.nonconformance_id, { dispositionTypeCode: 'NORMAL', decisionQty: 6 }).expect(201);
      const refused = await applyConcession(created.body.concessionId as number).expect(400);
      expect(JSON.stringify(refused.body)).toContain('approvedQty');

      const concession = await prisma.concession.findUniqueOrThrow({ where: { concession_id: BigInt(created.body.concessionId as number) } });
      expect(concession.status_code).toBe('PENDING');
      expect(await prisma.disposition_decision.count({
        where: { nonconformance_id: nc.nonconformance_id, disposition_type_code: 'CONCESSION' },
      })).toBe(0);
    });

    it('⛔ 같은 부적합에 승인된 특채 2건 — 첫 적용은 200, 남은 수량을 넘는 두 번째 적용은 400', async () => {
      const { lotId } = await rejectedLot(10);
      const nc = await openNonconformance(lotId);
      // ⚠ 결재 코어가 같은 부적합에 «진행 중» 결재를 둘 두지 않는다 — 첫 결재가 끝난 뒤 둘째를 올린다.
      const first = await requestConcession(nc.nonconformance_id, lotId, 6, '특채 1').expect(201);
      await decideApproval(first.body.approvalRequestId as number, 'approve');
      const second = await requestConcession(nc.nonconformance_id, lotId, 6, '특채 2').expect(201);
      await decideApproval(second.body.approvalRequestId as number, 'approve');

      await applyConcession(first.body.concessionId as number).expect(200);
      const refused = await applyConcession(second.body.concessionId as number).expect(400);
      expect(JSON.stringify(refused.body)).toContain('approvedQty');

      const decisions = await prisma.disposition_decision.findMany({ where: { nonconformance_id: nc.nonconformance_id } });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decision_qty.toNumber()).toBe(6);
    });

    it('⛔ 남은 수량을 넘거나 사유가 비면 400 이다', async () => {
      const { lotId } = await rejectedLot(10);
      const nc = await openNonconformance(lotId);

      await requestConcession(nc.nonconformance_id, lotId, 11, '수량 초과').expect(400);
      await requestConcession(nc.nonconformance_id, lotId, 5, '  ').expect(400);
    });
  });

  async function rejectedLot(qty: number) {
    const lot = await registerIqcLot(qty);
    const resultId = await draft(lot.requestId, { acceptedQty: 0, rejectedQty: qty });
    await recordReason(resultId);
    await confirm(resultId, 'REJECTED').expect(200);
    return { ...lot, resultId };
  }

  /** IQC 대상 입하 라인 + LOT 등록(실제 API) — 검사기준이 없어도 기준 빈 의뢰가 선다(#101). */
  async function registerIqcLot(qty: number): Promise<{ lotId: number; lineId: number; requestId: number }> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: inboundReceiptId,
        line_no: lineNo,
        item_id: BigInt(itemId),
        received_qty: qty,
        uom_id: BigInt(uomId),
        supplier_lot_label_attached: false,
        inspection_required: true,
        status_code: 'REGISTERED',
      },
    });
    const created = await request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        itemId,
        lotTypeCode: 'MATERIAL',
        plantId,
        initialQty: qty,
        uomId,
        sourceTypeCode: 'INBOUND_RECEIPT_LINE',
        sourceId: Number(line.inbound_receipt_line_id),
        numberSourceCode: 'MES',
        businessDate: DAY,
        occurredAt: `${DAY}T02:00:00.000Z`,
      })
      .expect(201);
    const lotId = created.body.lot.lotId as number;
    const iqc = await prisma.inspection_request.findFirstOrThrow({
      where: { lot_id: BigInt(lotId), inspection_type_code: 'IQC' },
      select: { inspection_request_id: true },
    });
    return { lotId, lineId: Number(line.inbound_receipt_line_id), requestId: Number(iqc.inspection_request_id) };
  }

  async function draft(
    requestId: number,
    qty: { acceptedQty: number; rejectedQty: number; previousResultId?: number },
  ): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionRequestId: requestId,
        inspectedQty: qty.acceptedQty + qty.rejectedQty,
        acceptedQty: qty.acceptedQty,
        rejectedQty: qty.rejectedQty,
        heldQty: 0,
        uomId,
        inspectedAt: `${DAY}T03:00:00.000Z`,
        statusCode: 'DRAFT',
        ...(qty.previousResultId === undefined ? {} : { previousResultId: qty.previousResultId }),
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
      .send({ overallJudgmentCode: judgment });
  }

  function confirmWith(resultId: number, body: Record<string, unknown>, version: number): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/inspection-results/${resultId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', `W/"${version}"`)
      .send(body);
  }

  function saveDraft(
    resultId: number,
    version: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .put(`/api/quality/inspection-results/${resultId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', `W/"${version}"`)
      .set(headers)
      .send(body);
  }

  /** `GET /quality/defect-records` 가 돌려주는 사유 — 결과로 좁히거나(기간 불필요) LOT 과 넓은 기간으로 본다. */
  async function listedReasons(filter: { inspectionResultId?: number; lotId?: number }): Promise<(string | null)[]> {
    const query = filter.inspectionResultId === undefined
      ? { lotId: filter.lotId, detectedFrom: '2000-01-01T00:00:00.000Z', detectedTo: '2100-01-01T00:00:00.000Z' }
      : { inspectionResultId: filter.inspectionResultId };
    const response = await request(app.getHttpServer())
      .get('/api/quality/defect-records')
      .query({ ...query, page: 1, size: 100 })
      .set('Cookie', cookie)
      .expect(200);
    return (response.body.items as { defectDescription?: string | null }[]).map((row) => row.defectDescription ?? null);
  }

  async function reasonsOf(resultId: number): Promise<(string | null)[]> {
    const rows = await prisma.defect_record.findMany({
      where: { inspection_result_id: BigInt(resultId) },
      orderBy: { defect_record_id: 'asc' },
      select: { defect_description: true },
    });
    return rows.map((row) => row.defect_description);
  }

  async function recordReason(resultId: number): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/quality/defect-records')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        sourceCode: 'IQC',
        defectCodeId,
        defectQty: 1,
        uomId,
        detectedAt: `${DAY}T03:10:00.000Z`,
        inspectionResultId: resultId,
        defectDescription: '외관 긁힘',
      })
      .expect(201);
  }

  function decide(nonconformanceId: bigint, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/nonconformances/${String(nonconformanceId)}/disposition-decisions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', 'W/"1"')
      .send({ uomId, reason: 'e2e 처분', ...body });
  }

  function receive(
    lotId: number,
    lineId: number,
    qty: number,
    to: { warehouseId: number; locationId: number } = { warehouseId, locationId },
  ): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId,
        warehouseId: to.warehouseId,
        receiptDatetime: `${DAY}T05:00:00.000Z`,
        businessDate: DAY,
        lines: [
          {
            inboundReceiptLineId: lineId,
            itemId,
            lotId,
            receiptQty: qty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: to.locationId,
          },
        ],
      });
  }

  async function requestStatus(requestId: number): Promise<string> {
    return (await prisma.inspection_request.findUniqueOrThrow({
      where: { inspection_request_id: BigInt(requestId) }, select: { status_code: true },
    })).status_code;
  }

  /** IQC 판정 화면 대기 큐(W-01-01 — `pendingOnly` 고정)에 선 의뢰들. */
  async function pendingQueueIds(): Promise<number[]> {
    const response = await request(app.getHttpServer())
      .get('/api/quality/inspection-requests')
      .query({ inspectionTypeCode: 'IQC', pendingOnly: 'true', page: 1, size: 100 })
      .set('Cookie', cookie)
      .expect(200);
    return (response.body.items as { inspectionRequestId: number }[]).map((row) => row.inspectionRequestId);
  }

  async function lotStatus(lotId: number): Promise<string> {
    return (await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) }, select: { status_code: true } })).status_code;
  }

  async function openInspectionHolds(lotId: number): Promise<number> {
    return prisma.lot_hold.count({
      where: { lot_id: BigInt(lotId), reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null },
    });
  }

  async function openNonconformance(lotId: number) {
    const row = await prisma.nonconformance_lot.findFirstOrThrow({
      where: { lot_id: BigInt(lotId), nonconformance: { closed_at: null } },
      select: { nonconformance: { select: { nonconformance_id: true, status_code: true, inspection_result_id: true, version_no: true } } },
    });
    return row.nonconformance;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'IQC흐름법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'IQC흐름사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'IQC흐름공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: { item_code: ITEM_CODE, item_name: 'IQC흐름품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true, inspection_required: true },
    });
    itemId = Number(item.item_id);
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`,
        warehouse_name: 'IQC흐름창고', warehouse_type_code: 'RAW', management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const location = await prisma.location.create({
      data: { warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: 'IQC흐름위치', location_type_code: 'BIN' },
    });
    locationId = Number(location.location_id);
    const defectWarehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-NG`,
        warehouse_name: 'IQC흐름불량창고', warehouse_type_code: 'RAW', management_level_code: 'LOCATION', is_defect: true,
      },
    });
    defectWarehouseId = Number(defectWarehouse.warehouse_id);
    const defectLocation = await prisma.location.create({
      data: { warehouse_id: defectWarehouse.warehouse_id, location_code: `${PREFIX}-NGLOC`, location_name: 'IQC흐름불량위치', location_type_code: 'BIN' },
    });
    defectLocationId = Number(defectLocation.location_id);
    const supplier = await prisma.partner.create({ data: { partner_code: SUPPLIER_CODE, partner_name: 'IQC흐름공급사' } });
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`, supplier_id: supplier.partner_id, plant_id: plant.plant_id,
        receipt_datetime: new Date(`${DAY}T02:00:00.000Z`), status_code: 'REGISTERED',
      },
    });
    inboundReceiptId = receipt.inbound_receipt_id;
    const code = await prisma.defect_code.create({ data: { defect_code: DEFECT_CODE, defect_name: 'IQC흐름불량' } });
    defectCodeId = Number(code.defect_code_id);
    // 수입검사 공정은 시드가 세운다(`seedSystemProcesses`) — 없으면 불량 기록이 400 이다.
    await prisma.process.upsert({
      where: { process_code: 'IQC' },
      update: {},
      create: { process_code: 'IQC', process_name: '수입검사', process_type_code: 'INSPECTION' },
    });
  }

  function requestConcession(nonconformanceId: bigint, lotId: number, approvedQty: number, reason: string): request.Test {
    return request(app.getHttpServer())
      .post('/api/quality/concessions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ nonconformanceId: Number(nonconformanceId), lotId, approvedQty, uomId, validFrom: DAY, reason });
  }

  function applyConcession(concessionId: number): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/concessions/${concessionId}:apply`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key());
  }

  /** 결재(200 까지 본다) — 상세의 ETag 로 판을 맞춘다. 반려는 사유가 필수다. */
  async function decideApproval(approvalRequestId: number, action: 'approve' | 'reject'): Promise<void> {
    const detail = await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${approvalRequestId}`)
      .set('Cookie', approverCookie)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/app/approval-requests/${approvalRequestId}:${action}`)
      .set('Cookie', approverCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', String(detail.headers.etag))
      .send(action === 'reject' ? { comment: 'e2e 반려' } : {})
      .expect(200);
  }

  async function makeApprover(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: APPROVER_LOGIN_ID, user_name: 'IQC흐름결재자', status_code: 'EMPLOYED' } });
    approverUserId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: APPROVER_ROLE, role_name: 'IQC흐름결재용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-03-09' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    // 특채 결재는 공통본(사업부 없음) 결재선을 고른다(특채 요청이 사업부를 싣지 않는다).
    await seedRoute(prisma, 'CONCESSION', [user.app_user_id]);
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId: APPROVER_LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    approverCookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: 'IQC흐름', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'IQC흐름용' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    // #104 — 관리웹 판정의 검사자는 계정에 연결된 작업자다.
    const unit = await prisma.business_unit.findFirstOrThrow({ where: { business_unit_code: `${PREFIX}-BU` } });
    await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`, worker_name: 'IQC흐름검사자', business_unit_id: unit.business_unit_id,
        plant_id: BigInt(plantId), app_user_id: user.app_user_id, status_code: 'EMPLOYED',
      },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 재고 스위트들과 같은 이유다. */
  async function cleanup(): Promise<void> {
    const lotsOfPlant = `SELECT lot_id FROM trace.lot WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    await prisma.$executeRawUnsafe(`TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`);
    // 특채 결재(#84) — 특채가 결재 요청을 잡으므로 아래 목록보다 «먼저» 지운다.
    await prisma.$executeRawUnsafe(`DELETE FROM quality.concession WHERE lot_id IN (${lotsOfPlant})`);
    await prisma.$executeRawUnsafe(`DELETE FROM quality.disposition_decision WHERE approval_request_id IN (SELECT approval_request_id FROM app.approval_request WHERE approval_type_code = 'CONCESSION' AND requested_by IN (SELECT app_user_id FROM app.app_user WHERE login_id = '${LOGIN_ID}'))`);
    await prisma.$executeRawUnsafe(`DELETE FROM app.approval_step WHERE approval_request_id IN (SELECT approval_request_id FROM app.approval_request WHERE approval_type_code = 'CONCESSION' AND requested_by IN (SELECT app_user_id FROM app.app_user WHERE login_id = '${LOGIN_ID}'))`);
    await prisma.$executeRawUnsafe(`DELETE FROM app.approval_request WHERE approval_type_code = 'CONCESSION' AND requested_by IN (SELECT app_user_id FROM app.app_user WHERE login_id = '${LOGIN_ID}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM app.approval_route_step WHERE approver_user_id IN (SELECT app_user_id FROM app.app_user WHERE login_id = '${APPROVER_LOGIN_ID}')`);
    await prisma.$executeRawUnsafe(`DELETE FROM app.approval_route WHERE approval_type_code = 'CONCESSION' AND NOT EXISTS (SELECT 1 FROM app.approval_route_step s WHERE s.approval_route_id = approval_route.approval_route_id)`);
    const approver = await prisma.app_user.findUnique({ where: { login_id: APPROVER_LOGIN_ID } });
    if (approver) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: approver.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: approver.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: approver.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: approver.app_user_id } });
    }
    const approverRole = await prisma.role.findUnique({ where: { role_code: APPROVER_ROLE } });
    if (approverRole) {
      await prisma.role_permission.deleteMany({ where: { role_id: approverRole.role_id } });
      await prisma.role.delete({ where: { role_id: approverRole.role_id } });
    }
    for (const sql of [
      `DELETE FROM logistics.stock_transfer_line WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM logistics.stock_transfer WHERE disposition_decision_id IN (SELECT disposition_decision_id FROM quality.disposition_decision WHERE nonconformance_id IN (SELECT nonconformance_id FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant})))`,
      `DELETE FROM logistics.putaway_task WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (SELECT nonconformance_id FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant}))`,
      `DELETE FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code = '${ITEM_CODE}')`,
      `DELETE FROM quality.defect_record WHERE defect_code_id IN (SELECT defect_code_id FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}')`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (SELECT inspection_request_id FROM quality.inspection_request WHERE lot_id IN (${lotsOfPlant}))`,
      `DELETE FROM quality.inspection_request WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${lotsOfPlant}) OR target_lot_id IN (${lotsOfPlant})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code = '${SUPPLIER_CODE}'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code = '${ITEM_CODE}'`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
