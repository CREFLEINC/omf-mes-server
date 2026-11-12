/**
 * IQC 불합격 → 처분(재작업) → 재검사 → 입고 (e2e · omf-all-around#106).
 *
 * 실제 API 로 잇는다 — 자재 관리 LOT 발행(W-01-14) · 받기(M-01-01) · 입하 마감(→ 입하 LOT IQC 요청) · 판정(W-01-01) ·
 * 처분(W-03-10) · 입고(W-01-10). 옛 LOT 등록(`POST /trace/lots`)은 닫혔다(피처 005 FR-036).
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
import { Authorize, InboundLotFixture, closeInboundLotFixture, defaultMatchedLotIds, issueAndReceive } from './support/inbound-lot-fixture';

const LOGIN_ID = 'e2e-iqc-flow';
const PASSWORD = 'IQC-흐름-비밀번호';
const PREFIX = 'IQCFLOW';
const ITEM_CODE = 'IQCFLOW-ITEM';
const SUPPLIER_CODE = 'IQCFLOW-SUP';
const DEFECT_CODE = 'IQCFLOW-DEF';
const ROLE = 'E2E_IQC_FLOW';
// W-CO-06 — 단말 토큰 발급(#122 리뷰 m3 의 단말 PUT 케이스). W-04-11 — 재고 재등록(#108 리뷰 M1).
// W-01-14·M-01-01 — 입하 LOT 픽스처의 자재 관리 LOT 발행·받기(피처 005).
const PERMISSIONS = ['P-01-01', 'W-01-01', 'W-01-15', 'W-03-10', 'W-01-10', 'W-CO-06', 'W-04-11', 'W-01-14', 'M-01-01'];
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
  let supplierId: number;
  let legacySeq = 0;
  let fx: InboundLotFixture;
  const keys = new Set<string>();

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
    const asUser: Authorize = (test) => test.set('Cookie', cookie);
    fx = { app, issuer: asUser, receiver: asUser, businessDate: DAY, keys, inspector: asUser, prisma };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 합격 전에는 입고되지 않는다(#100) — 불합격은 사유(#106) 없이도 확정되고 부적합이 선다(P-41 · 사용자 결정 2026-11-10)', async () => {
    const { lotId, lineId, requestId } = await registerIqcLot(10);
    await receive(lotId, lineId, 10).expect(400);

    const resultId = await draft(requestId, { acceptedQty: 0, rejectedQty: 10, judgment: 'REJECTED' });
    await confirmRequest(requestId);

    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
    const nc = await openNonconformance(lotId);
    expect(nc).toMatchObject({ status_code: 'PENDING_DECISION', inspection_result_id: BigInt(resultId) });
    const created = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nc.nonconformance_id }, select: { description: true } });
    expect(created.description).toBe('수입검사 불합격');
    expect(await prisma.defect_record.count({ where: { inspection_result_id: BigInt(resultId) } })).toBe(0);
    await receive(lotId, lineId, 10).expect(400);
  });

  it('불합격 확정은 그 LOT 으로 「검사 불합격(IQC)」 인계 알림을 한 번 남긴다 — 입하·LOT·수량·다음 할 일', async () => {
    const { lotId } = await rejectedLot(10);
    const where = { event_type_code: 'IQC_INSPECTION_REJECTED', aggregate_type_code: 'LOT', aggregate_id: BigInt(lotId) };
    const events = await prisma.notification_event.findMany({ where, select: { payload: true } });
    try {
      expect(events).toHaveLength(1);
      const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) }, select: { lot_no: true } });
      expect(events[0].payload).toMatchObject({ lot_no: lot.lot_no, qty: expect.stringMatching(/^10\b/), next_step: '부적합 처분(W-03-10)에서 처분 판정' });
      expect((events[0].payload as { receipt_no?: string }).receipt_no).toEqual(expect.any(String));
    } finally {
      await prisma.notification_event.deleteMany({ where });
    }
  });

  it('⭐ 불합격 LOT 은 불량창고로만 입고된다(#100 · P-45) — 일반 창고는 계속 거부', async () => {
    const { lotId, lineId } = await rejectedLot(10);

    const rejected = await receive(lotId, lineId, 10).expect(400);
    expect(JSON.stringify(rejected.body)).toContain('불량창고로만');
    await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
  });

  it('⭐ 무검사 품목의 불량 LOT 도 불량창고로만 입고된다(사용자 결정 2026-10-23 · P-45) — 일반 창고는 거부', async () => {
    const { lotId, lineId } = await registerIqcLot(10);
    // 무검사 품목 LOT 에 클레임 재Hold(C9)가 걸린 그 상태 — 입하 라인은 검사 대상이 아니고 LOT 은 불량이다.
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: BigInt(lineId) }, data: { inspection_required: false } });
    await prisma.lot.update({ where: { lot_id: BigInt(lotId) }, data: { status_code: 'DEFECTIVE' } });

    const rejected = await receive(lotId, lineId, 10).expect(400);
    expect(JSON.stringify(rejected.body)).toContain('불량창고로만');
    await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
  });

  it('⭐ 경로 ① 처분 정상 → 보류 해제 → 입고', async () => {
    const { lotId, lineId } = await rejectedLot(10);
    const nc = await openNonconformance(lotId);

    await decide(nc.nonconformance_id, { dispositionTypeCode: 'NORMAL', decisionQty: 10 }).expect(201);

    expect(await lotStatus(lotId)).toBe('NORMAL');
    expect(await openInspectionHolds(lotId)).toBe(0);
    await receive(lotId, lineId, 10).expect(201);
  });

  it('⛔ R14a-1 경로 ② 수량 분할 선별은 400 — LOT 은 불량·보류 그대로, 아무것도 갈리지 않는다(FR-038)', async () => {
    const { lotId } = await rejectedLot(10);
    const nc = await openNonconformance(lotId);

    const refused = await decide(nc.nonconformance_id, {
      dispositionTypeCode: 'SORT',
      decisionQty: 10,
      acceptedQty: 7,
      rejectedQty: 3,
      businessDate: DAY,
    }).expect(400);

    expect(JSON.stringify(refused.body)).toContain('선별은 지원하지 않습니다');
    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
    expect(await openInspectionHolds(lotId)).toBe(1);
    expect(await prisma.lot_relation.count({ where: { source_lot_id: BigInt(lotId) } })).toBe(0);
    expect(await prisma.disposition_decision.count({ where: { nonconformance_id: nc.nonconformance_id } })).toBe(0);
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
    const { lotId, lineId, requestId } = await rejectedLot(10);
    const nc = await openNonconformance(lotId);

    expect(await requestStatus(requestId)).toBe('COMPLETED');
    await decide(nc.nonconformance_id, { dispositionTypeCode: 'REWORK', decisionQty: 10 }).expect(201);
    expect(await lotStatus(lotId)).toBe('INSPECTION_PENDING');
    expect(await openInspectionHolds(lotId)).toBe(1);
    await receive(lotId, lineId, 10).expect(400);
    // 재작업이 IQC 의뢰를 다시 연다 — 판정 화면 대기 큐에 다시 떠야 재검사를 시작한다(장부 P-43 · 3단계 검증).
    expect(await requestStatus(requestId)).toBe('IN_PROGRESS');
    expect(await pendingQueueIds()).toContain(requestId);

    // 입하 LOT 검사는 재검사 결과를 더해 검사 단위로 다시 확정한다(R-15 · D-10·D-11 — 회차 사슬 없음).
    // 앞 불합격을 덮는 재검 결과라 재검 사유가 필요하다(2026-11-12).
    await draft(requestId, { acceptedQty: 10, rejectedQty: 0, judgment: 'ACCEPTED', reinspectionReasonCode: 'RETEST' });
    expect(await requestStatus(requestId)).toBe('IN_PROGRESS');
    await confirmRequest(requestId);
    expect(await requestStatus(requestId)).toBe('COMPLETED');

    expect(await lotStatus(lotId)).toBe('NORMAL');
    expect(await openInspectionHolds(lotId)).toBe(0);
    await receive(lotId, lineId, 10).expect(201);
  });

  /* #121 · 장부 P-47 — 사유를 `:confirm` 에 실으면 확정과 한 트랜잭션에서 그 회차의 기록을 갈아 끼운다. */
  it('⭐ 불합격 확정 재시도에도 그 회차의 사유는 확정 시점 입력 1벌이다', async () => {
    // 결과 단위 확정은 이전된 옛 요청에만 남는다(피처 005 D-11 · FR-051).
    const { requestId } = await legacyIqcLot(10);
    const resultId = await draft(requestId, { acceptedQty: 0, rejectedQty: 10 });
    const reason = (description: string) => ({ overallJudgmentCode: 'REJECTED', defects: [{ defectCodeId, defectQty: 10, defectDescription: description }] });

    // 옛 화면이 먼저 남긴 기록 + 확정 실패(버전 어긋남) — 실패한 확정은 기록을 바꾸지 않는다.
    await recordReason(resultId, 10);
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
    // 결과 단위 확정은 이전된 옛 요청에만 남는다(피처 005 D-11 · FR-051).
    const { lotId, requestId } = await legacyIqcLot(10);
    const resultId = await draft(requestId, { acceptedQty: 10, rejectedQty: 0 });
    await recordReason(resultId, 1);

    const invalid = await confirmWith(resultId, { overallJudgmentCode: 'ACCEPTED', defects: [{ defectCodeId, defectQty: 1 }] }, 1).expect(400);
    expect(JSON.stringify(invalid.body)).toContain('defects');
    await confirm(resultId, 'ACCEPTED').expect(200);

    expect(await reasonsOf(resultId)).toEqual([]);
    expect(await lotStatus(lotId)).toBe('NORMAL');
  });

  /* #122 · 장부 P-48 — 임시 저장이 사유를 그 회차의 불량 기록으로 갈아 끼우고, 확정 전 기록은 집계·기간 목록에 안 잡힌다. */
  it('⭐ 임시 저장한 불합격 사유가 다시 읽히고, 사유 없이 확정하면 그 사유로 확정된다', async () => {
    // 결과 단위 확정은 이전된 옛 요청에만 남는다(피처 005 D-11 · FR-051).
    const { lotId, requestId } = await legacyIqcLot(10);
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

      // 특채는 남은 수량 전부다(FR-038 — 일부 특채 제거).
      const created = await requestConcession(nc.nonconformance_id, lotId, 10, '외관 경미 — 조건부 사용').expect(201);
      expect(created.body).toMatchObject({ statusCode: 'PENDING', approvedQty: 10, remarks: '외관 경미 — 조건부 사용' });
      const concessionId = created.body.concessionId as number;
      const approvalRequestId = created.body.approvalRequestId as number;

      // ⛔ 결재 전 적용은 400 — LOT 은 불량 그대로다.
      const early = await applyConcession(concessionId).expect(400);
      expect(JSON.stringify(early.body)).toContain('APPROVAL_IN_PROGRESS');
      expect(await lotStatus(lotId)).toBe('DEFECTIVE');

      await decideApproval(approvalRequestId, 'approve');
      const applied = await applyConcession(concessionId, { businessDate: DAY }).expect(200);
      expect(applied.body).toMatchObject({ statusCode: 'APPROVED', approvedQty: 10, usable: true, splitResult: null });

      expect(await lotStatus(lotId)).toBe('NORMAL');
      expect(await openInspectionHolds(lotId)).toBe(0);
      const decisions = await prisma.disposition_decision.findMany({ where: { nonconformance_id: nc.nonconformance_id } });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ disposition_type_code: 'CONCESSION', approval_request_id: BigInt(approvalRequestId) });
      expect(decisions[0].decision_qty.toNumber()).toBe(10);
      expect((await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nc.nonconformance_id } })).status_code).toBe('DECIDED');

      // 승인자·승인 일시는 결재 상세(W-03-09 화면), 사유·사용 가능 수량은 특채 상세가 낸다.
      const approval = await request(app.getHttpServer()).get(`/api/app/approval-requests/${approvalRequestId}`).set('Cookie', approverCookie).expect(200);
      expect(approval.body.request).toMatchObject({ statusCode: 'APPROVED', approvalTypeCode: 'CONCESSION', reason: '외관 경미 — 조건부 사용' });
      expect(approval.body.steps[0]).toMatchObject({ approverId: Number(approverUserId), decisionCode: 'APPROVED' });
      expect(approval.body.steps[0].decisionAt).toEqual(expect.any(String));
      const detail = await request(app.getHttpServer()).get(`/api/quality/concessions/${concessionId}`).set('Cookie', cookie).expect(200);
      expect(detail.body).toMatchObject({ approvedQty: 10, consumedQty: 0, remarks: '외관 경미 — 조건부 사용', lotId });

      // 특채 LOT 은 승인 수량(10)까지 일반 창고로 입고된다(장부 P-56).
      await receive(lotId, lineId, 11).expect(400);
      await receive(lotId, lineId, 10).expect(201);
      // 입고 전 특채는 원 LOT 이 불량창고 재고가 없어 W-04-11 목록에 나오지 않는다.
      expect(await reinstatableOf(nc.nonconformance_id)).toEqual([]);
    });

    it('⛔ R14a-1 일부 수량 특채 요청은 400 — 특채·결재가 서지 않는다(FR-038)', async () => {
      const { lotId, lineId } = await rejectedLot(10);
      await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
      const nc = await openNonconformance(lotId);
      const refused = await requestConcession(nc.nonconformance_id, lotId, 6, '불량창고 일부 특채').expect(400);
      expect(JSON.stringify(refused.body)).toContain('approvedQty');

      expect(await prisma.concession.count({ where: { nonconformance_id: nc.nonconformance_id } })).toBe(0);
      expect(await lotStatus(lotId)).toBe('DEFECTIVE');
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

    it('⭐ 불량창고 재고는 재고 재등록(처분 «특채»)으로 일반 창고에 정상·가용으로 옮긴다 — 보류는 고르지 않는다(#207)', async () => {
      const { lotId, lineId } = await rejectedLot(10);
      await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
      const nc = await openNonconformance(lotId);
      const created = await requestConcession(nc.nonconformance_id, lotId, 10, '불량창고 특채 재등록').expect(201);
      await decideApproval(created.body.approvalRequestId as number, 'approve');
      await applyConcession(created.body.concessionId as number).expect(200);
      const decision = await prisma.disposition_decision.findFirstOrThrow({
        where: { nonconformance_id: nc.nonconformance_id, disposition_type_code: 'CONCESSION' }, select: { disposition_decision_id: true },
      });
      const decisionId = Number(decision.disposition_decision_id);

      // W-04-11 진입 목록 — 불량창고 재고가 남은 특채 판정은 재등록 대상이다.
      expect(await reinstatableOf(nc.nonconformance_id)).toEqual([decisionId]);

      const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) }, select: { version_no: true } });
      const reinstate = (extra: Record<string, unknown>): request.Test =>
        request(app.getHttpServer())
          .post('/api/logistics/stock-reinstatements')
          .set('Cookie', cookie)
          .set('Idempotency-Key', key())
          .send({
            dispositionDecisionId: decisionId, lot: { lotId, versionNo: lot.version_no }, toWarehouseId: warehouseId,
            toLocationId: locationId, uomId, businessDate: DAY, occurredAt: new Date().toISOString(), ...extra,
          });
      // ⛔ 특채 승인 수량(10)을 넘기거나 보류를 고르면 400 이다.
      await reinstate({ qty: 11 }).expect(400);
      const held = await reinstate({ qty: 10, lotHoldId: 1 }).expect(400);
      expect(JSON.stringify(held.body)).toContain('lotHoldId');

      const done = await reinstate({ qty: 10 }).expect(201);
      expect(done.body).toMatchObject({ lotStatusCode: 'NORMAL', releasedLotHoldId: null, reinstatedQty: 10 });
      // 다 옮기면 목록에서 빠진다(#207).
      expect(await reinstatableOf(nc.nonconformance_id)).toEqual([]);
      const rows = await prisma.inventory_balance.findMany({
        where: { lot_id: BigInt(lotId), on_hand_qty: { gt: 0 } },
        select: { warehouse_id: true, quality_status_code: true, inventory_status_code: true, on_hand_qty: true },
      });
      expect(rows.map((row) => [Number(row.warehouse_id), row.quality_status_code, row.inventory_status_code, row.on_hand_qty.toNumber()]))
        .toEqual([[warehouseId, 'NORMAL', 'AVAILABLE', 10]]);
    });

    it('⛔ 요청 뒤 다른 처분이 수량을 먼저 쓰면 적용이 400(approvedQty)이고 특채·LOT·판정은 그대로다', async () => {
      // 일부 수량 처분은 이전 데이터 부적합에만 남는다 — 입하 LOT 검사 부적합은 남은 수량 전부로만 판정한다(FR-038 · G2 M3).
      const { lotId } = await rejectedLot(10, true);
      const nc = await openNonconformance(lotId);
      const created = await requestConcession(nc.nonconformance_id, lotId, 10, '적용 전 처분 선행').expect(201);
      await decideApproval(created.body.approvalRequestId as number, 'approve');

      // 처분 정상 6 이 먼저 확정됐다 — 남은 수량 4 < 승인 10.
      await decide(nc.nonconformance_id, { dispositionTypeCode: 'NORMAL', decisionQty: 6 }).expect(201);
      const refused = await applyConcession(created.body.concessionId as number).expect(400);
      expect(JSON.stringify(refused.body)).toContain('approvedQty');

      const concession = await prisma.concession.findUniqueOrThrow({ where: { concession_id: BigInt(created.body.concessionId as number) } });
      expect(concession.status_code).toBe('PENDING');
      expect(await prisma.disposition_decision.count({
        where: { nonconformance_id: nc.nonconformance_id, disposition_type_code: 'CONCESSION' },
      })).toBe(0);
    });

    it('⛔ 같은 부적합에 승인된 특채 2건 — 첫 적용은 200(종결), 두 번째 적용은 400', async () => {
      const { lotId } = await rejectedLot(10);
      const nc = await openNonconformance(lotId);
      // ⚠ 결재 코어가 같은 부적합에 «진행 중» 결재를 둘 두지 않는다 — 첫 결재가 끝난 뒤 둘째를 올린다.
      const first = await requestConcession(nc.nonconformance_id, lotId, 10, '특채 1').expect(201);
      await decideApproval(first.body.approvalRequestId as number, 'approve');
      const second = await requestConcession(nc.nonconformance_id, lotId, 10, '특채 2').expect(201);
      await decideApproval(second.body.approvalRequestId as number, 'approve');

      // 첫 적용이 남은 수량 전부로 원 부적합을 닫으므로 두 번째는 종결된 부적합이라 400 이다.
      await applyConcession(first.body.concessionId as number, { businessDate: DAY }).expect(200);
      const refused = await applyConcession(second.body.concessionId as number, { businessDate: DAY }).expect(400);
      expect(JSON.stringify(refused.body)).toContain('STATE_LOCKED');

      const decisions = await prisma.disposition_decision.findMany({ where: { nonconformance_id: nc.nonconformance_id } });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decision_qty.toNumber()).toBe(10);
    });

    it('⛔ 남은 수량을 넘거나 사유가 비면 400 이다', async () => {
      const { lotId } = await rejectedLot(10);
      const nc = await openNonconformance(lotId);

      await requestConcession(nc.nonconformance_id, lotId, 11, '수량 초과').expect(400);
      await requestConcession(nc.nonconformance_id, lotId, 5, '  ').expect(400);
    });
  });

  /** W-04-11 진입 목록 — 이 부적합의 재등록 대상 판정 id(#207). */
  async function reinstatableOf(nonconformanceId: bigint): Promise<number[]> {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/disposition-decisions?nonconformanceId=${String(nonconformanceId)}&reinstatable=true`)
      .set('Cookie', cookie)
      .expect(200);
    return (response.body.items as { dispositionDecisionId: number }[]).map((row) => row.dispositionDecisionId);
  }

  async function rejectedLot(qty: number, legacy = false) {
    const lot = legacy ? await legacyIqcLot(qty) : await registerIqcLot(qty);
    const resultId = await draft(lot.requestId, { acceptedQty: 0, rejectedQty: qty, ...(legacy ? {} : { judgment: 'REJECTED' }) });
    await recordReason(resultId, qty);
    // 입하 LOT 검사는 검사 단위로 확정한다(피처 005 D-11) — 옛 요청은 결과 단위 그대로.
    if (legacy) await confirm(resultId, 'REJECTED').expect(200);
    else await confirmRequest(lot.requestId);
    return { ...lot, resultId };
  }

  /**
   * IQC 대상 자재 관리 LOT 하나 — 발행 → 받기 → 입하 마감(실제 API). 마감이 입하 LOT 단위 IQC 요청을 세운다
   * (검사기준이 없어도 기준 빈 요청이 선다 · #101). 줄은 그 LOT 의 원천 입하 줄이다.
   */
  async function registerIqcLot(qty: number): Promise<{ lotId: number; lineId: number; requestId: number }> {
    const { inboundLot, lots } = await issueAndReceive(fx, { plantId, supplierId, itemId, lotQty: qty, lotCount: 1 });
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    if (closed.iqcRequestId === null) throw new Error('입하 마감이 IQC 요청을 세우지 않았다 — 검사 필요 품목이어야 한다');
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lots[0].lotId) }, select: { source_id: true } });
    return { lotId: lots[0].lotId, lineId: Number(lot.source_id), requestId: closed.iqcRequestId };
  }

  /**
   * 옛 LOT 등록(이제 닫힘 · FR-036)이 쓰던 이전 데이터 모양 — 입하 줄 + 검사 대기 LOT + 수입검사 대기 보류 + LOT 단위 IQC 요청 + 줄 `lot_id`.
   * 결과 단위 확정·회차 사슬은 이전된 옛 요청에만 남는다(FR-051) — 그것을 보는 시험만 이 모양으로 잰다.
   */
  async function legacyIqcLot(qty: number): Promise<{ lotId: number; lineId: number; requestId: number }> {
    legacySeq += 1;
    const at = new Date(`${DAY}T02:00:00.000Z`);
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR-L${legacySeq}`, supplier_id: BigInt(supplierId), plant_id: BigInt(plantId), receipt_datetime: at,
        status_code: 'REGISTERED',
      },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: receipt.inbound_receipt_id, line_no: 1, item_id: BigInt(itemId), received_qty: qty, uom_id: BigInt(uomId),
        supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED',
      },
    });
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LEGACY-${legacySeq}`, item_id: BigInt(itemId), lot_type_code: 'MATERIAL', plant_id: BigInt(plantId), initial_qty: qty,
        uom_id: BigInt(uomId), source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'INSPECTION_PENDING',
      },
    });
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID }, select: { app_user_id: true } });
    await prisma.lot_hold.create({
      data: {
        lot_id: lot.lot_id, reason_code: 'INCOMING_INSPECTION_WAIT', status_code: 'HELD', target_lot_status_code: 'INSPECTION_PENDING',
        held_by: user.app_user_id, held_at: new Date(),
      },
    });
    const iqc = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}-IQC-L${legacySeq}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lot.lot_id,
        item_id: BigInt(itemId), lot_id: lot.lot_id, target_qty: qty, uom_id: BigInt(uomId), status_code: 'REQUESTED', requested_at: at,
      },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id }, data: { lot_id: lot.lot_id } });
    return { lotId: Number(lot.lot_id), lineId: Number(line.inbound_receipt_line_id), requestId: Number(iqc.inspection_request_id) };
  }

  async function draft(
    requestId: number,
    qty: { acceptedQty: number; rejectedQty: number; previousResultId?: number; judgment?: string; reinspectionReasonCode?: string },
  ): Promise<number> {
    // 2026-11-12 매칭 필수 — 입하 LOT 요청이면 자재 관리 LOT 를 매칭한다(옛 요청은 칸 없음).
    const matchedLotIds = await defaultMatchedLotIds(prisma, requestId);
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
        ...(qty.judgment === undefined ? {} : { overallJudgmentCode: qty.judgment }),
        ...(matchedLotIds === undefined ? {} : { matchedLotIds }),
        ...(qty.reinspectionReasonCode === undefined ? {} : { reinspectionReasonCode: qty.reinspectionReasonCode }),
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

  /** 입하 LOT 검사의 판정 확정(검사 단위 · W-01-15 · 피처 005 S9). */
  async function confirmRequest(requestId: number): Promise<void> {
    const { version_no: versionNo } = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } });
    await request(app.getHttpServer())
      .post(`/api/quality/inspection-requests/${requestId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ versionNo })
      .expect(200);
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

  async function recordReason(resultId: number, defectQty: number): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/quality/defect-records')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        sourceCode: 'IQC',
        defectCodeId,
        defectQty,
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
    supplierId = Number(supplier.partner_id);
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

  function applyConcession(concessionId: number, body?: { businessDate?: string }): request.Test {
    const call = request(app.getHttpServer())
      .post(`/api/quality/concessions/${concessionId}:apply`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key());
    return body === undefined ? call : call.send(body);
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
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lotsOfPlant = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    // 입하 LOT 요청은 `lot_id` 가 비어 있다 — 품목으로 찾는다.
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code = '${ITEM_CODE}')`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))
         OR (aggregate_type_code = 'LOT' AND aggregate_id IN (${lotsOfPlant}))`;
    await prisma.$executeRawUnsafe(`TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`);
    // 특채 결재(#84) — 특채가 결재 요청을 잡으므로 아래 목록보다 «먼저» 지운다.
    await prisma.$executeRawUnsafe(`DELETE FROM quality.concession WHERE lot_id IN (${lotsOfPlant})`);
    // 특채 재등록(#207)의 이동 문서가 특채 판정을 잡는다 — 판정보다 «먼저» 지운다.
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.stock_transfer_line WHERE lot_id IN (${lotsOfPlant})`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.stock_transfer WHERE disposition_decision_id IN (SELECT disposition_decision_id FROM quality.disposition_decision WHERE disposition_type_code = 'CONCESSION' AND nonconformance_id IN (SELECT nonconformance_id FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant})))`);
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
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
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
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests}))`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants}))`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${lotsOfPlant}) OR target_lot_id IN (${lotsOfPlant})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
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
