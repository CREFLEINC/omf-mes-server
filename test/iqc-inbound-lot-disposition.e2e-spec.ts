/**
 * 피처 005 S10 — 입하 LOT 단위 처분·다LOT 전량 특채·일부 특채와 수량 분할 선별 제거·재작업 재열기·IQC 생략(T069 · omf-all-around#254).
 * 처분 판정 하나가 부적합 LOT 전부를 옮기고(FR-031), 전량 특채는 LOT 마다 행·같은 결재로 묶여 한 번에 적용되고(D-14),
 * 일부 특채·수량 분할 선별은 막히고(FR-038), 재작업은 같은 입하 LOT 검사를 다시 열고(R-15), 생략은 마감된 입하 LOT 단위다(FR-032).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRoute } from './approval-request.fixture';
import {
  IssuedMaterialLot, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, terminalAuth, sessionAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'IQCD';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const RESULTS = '/api/quality/inspection-results';
const REQUESTS = '/api/quality/inspection-requests';
const CONCESSIONS = '/api/quality/concessions';
const APPROVALS = '/api/app/approval-requests';
/** 재검 사유(공통코드 `REINSPECTION_REASON` — 열린 그룹이라 마스터에 없어도 받는다). */
const REASON = `${PREFIX}-RT`;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object, 'quality');
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object, 'logistics');
const schemaOf = (file: string, path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `${file}#/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});
function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

interface IqcLot { requestId: number; inboundLotId: number; lots: IssuedMaterialLot[] }
interface Rejected extends IqcLot { nonconformanceId: bigint }

describe('피처 005 S10 입하 LOT 단위 처분·특채·재작업 재열기·IQC 생략 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let approverCookie: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let supplierSeq = 0;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code), WORKER_NO);
    approverCookie = await makeUser('APR', ['W-03-09', 'W-01-02'], `${PREFIX}-W2`);
    await seedRoute(prisma, 'CONCESSION', [ids.approver]);
    await seedRoute(prisma, 'IQC_SKIP', [ids.approver]);
    const pop = await terminalToken('POP');
    const mobile = await terminalToken('MOBILE');
    fx = { app, issuer: terminalAuth(pop, WORKER_NO), receiver: terminalAuth(mobile, WORKER_NO), businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('FR-031 정상·폐기·재작업 판정 하나가 부적합 LOT 전부를 옮긴다', async () => {
    for (const [type, status] of [['NORMAL', 'NORMAL'], ['SCRAP', 'SCRAPPED'], ['REWORK', 'INSPECTION_PENDING']] as const) {
      const nc = await rejectedIqc(3);
      await decide(nc.nonconformanceId, { dispositionTypeCode: type, decisionQty: 30 }, 201);
      expect(await lotStatuses(nc)).toEqual([status, status, status]);
      expect(await prisma.disposition_decision.count({ where: { nonconformance_id: nc.nonconformanceId } })).toBe(1);
    }
  });

  it('US4-4 전량 특채(lotId 생략) → 결재 1건·LOT 마다 특채 행 → 승인 → 아무 행으로 적용하면 묶음 전부·처분 판정 1건·LOT 전부 정상·부적합 닫힘', async () => {
    const nc = await rejectedIqc(3);
    // T074 — 부적합 조회에 검사 요청·입하 LOT 번호·LOT 별 불합격 결과 수(참고).
    const detail = await request(app.getHttpServer()).get(`/api/quality/nonconformances/${String(nc.nonconformanceId)}`).set('Cookie', cookie).expect(200);
    expect(detail.body).toMatchObject({ inspectionRequestId: nc.requestId, inboundLotNo: await inboundLotNoOf(nc) });
    expect((detail.body.lots as { lotId: number; rejectedResultCount: number }[]).map((lot) => [lot.lotId, lot.rejectedResultCount]))
      .toEqual(nc.lots.map((lot, index) => [lot.lotId, index === 0 ? 1 : 0]));

    const created = await requestConcession({ nonconformanceId: Number(nc.nonconformanceId), approvedQty: 30 }).expect(201);
    expectShape(schemaOf('quality', '/quality/concessions', 'post', 201), created.body);
    const concessionIds = created.body.concessionIds as number[];
    const approvalRequestId = created.body.approvalRequestId as number;
    expect(concessionIds).toHaveLength(3);
    expect(created.body.concessionId).toBe(concessionIds[0]);
    const rows = await prisma.concession.findMany({ where: { nonconformance_id: nc.nonconformanceId }, orderBy: { concession_id: 'asc' } });
    expect(rows.map((row) => [Number(row.concession_id), Number(row.lot_id), row.approved_qty.toNumber(), Number(row.approval_request_id), row.status_code]))
      .toEqual(nc.lots.map((lot, index) => [concessionIds[index], lot.lotId, 10, approvalRequestId, 'PENDING']));
    expect(await prisma.approval_request.count({ where: { approval_type_code: 'CONCESSION', target_id: nc.nonconformanceId } })).toBe(1);

    await decideApproval(approvalRequestId, 'approve');
    const applied = await applyConcession(concessionIds[1]).expect(200);
    expectShape(schemaOf('quality', '/quality/concessions/{concessionId}:apply', 'post', 200), applied.body);
    expect(applied.body).toMatchObject({ concessionId: concessionIds[1], statusCode: 'APPROVED', concessionIds, splitResult: null });
    const after = await prisma.concession.findMany({ where: { nonconformance_id: nc.nonconformanceId } });
    expect(after.map((row) => row.status_code)).toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
    const decisions = await prisma.disposition_decision.findMany({ where: { nonconformance_id: nc.nonconformanceId } });
    expect(decisions.map((row) => [row.disposition_type_code, row.decision_qty.toNumber(), Number(row.approval_request_id)])).toEqual([['CONCESSION', 30, approvalRequestId]]);
    expect(await lotStatuses(nc)).toEqual(['NORMAL', 'NORMAL', 'NORMAL']);
    expect(await openInspectionHolds(nc)).toBe(0);
    expect((await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nc.nonconformanceId } })).status_code).toBe('DECIDED');
    // 한 행만 적용되는 일은 없다 — 묶음의 다른 행으로 다시 불러도 409.
    await applyConcession(concessionIds[2]).expect(409);
    // 재고 재등록(특채 수량 = 결재·LOT 으로 찾음)·ERP 구매입고의 특채 LOT 제외(lot_id)가 LOT 마다 행을 찾는다.
    for (const lot of nc.lots) {
      const row = await prisma.concession.findFirst({ where: { approval_request_id: BigInt(approvalRequestId), lot_id: BigInt(lot.lotId) } });
      expect(row?.approved_qty.toNumber()).toBe(10);
    }
  });

  it('US4-4 LOT 하나인 부적합은 지금처럼 특채 행 하나다', async () => {
    const nc = await rejectedIqc(1);
    const created = await requestConcession({ nonconformanceId: Number(nc.nonconformanceId), lotId: nc.lots[0].lotId, approvedQty: 10 }).expect(201);
    expect(created.body).toMatchObject({ concessionIds: [created.body.concessionId], lotId: nc.lots[0].lotId, approvedQty: 10 });
    expect(await prisma.concession.count({ where: { nonconformance_id: nc.nonconformanceId } })).toBe(1);
  });

  it('R14a-1 approvedQty ≠ 남은 수량 400·다LOT 에 lotId 400·옛 수량 분할 SORT 400·반품 부적합 SORT 400 — 아무것도 바뀌지 않는다', async () => {
    const nc = await rejectedIqc(2);
    const partial = await requestConcession({ nonconformanceId: Number(nc.nonconformanceId), approvedQty: 15 }).expect(400);
    expect(JSON.stringify(partial.body)).toContain('approvedQty');
    await requestConcession({ nonconformanceId: Number(nc.nonconformanceId), lotId: nc.lots[0].lotId, approvedQty: 20 }).expect(400);
    const sort = await decide(nc.nonconformanceId, {
      dispositionTypeCode: 'SORT', decisionQty: 20, acceptedQty: 15, rejectedQty: 5, businessDate: DAY,
    }, 400);
    expect(JSON.stringify(sort.body)).toContain('수량으로 LOT 을 나누는 선별은 지원하지 않습니다');
    expect(await prisma.concession.count({ where: { nonconformance_id: nc.nonconformanceId } })).toBe(0);
    expect(await prisma.disposition_decision.count({ where: { nonconformance_id: nc.nonconformanceId } })).toBe(0);
    expect(await lotStatuses(nc)).toEqual(['DEFECTIVE', 'DEFECTIVE']);

    // 반품·OQC 부적합(검사 요청·입하 LOT 없음)에는 선별이 없다.
    const returned = await prisma.nonconformance.create({
      data: { nonconformance_no: `${PREFIX}-NC-R${String(++seq)}`, item_id: ids.item, severity_code: 'MINOR', description: '반품', status_code: 'PENDING_DECISION', opened_at: new Date() },
    });
    await prisma.nonconformance_lot.create({
      data: { nonconformance_id: returned.nonconformance_id, lot_id: BigInt(nc.lots[0].lotId), affected_qty: 10, uom_id: ids.ea,
        quality_status_before_code: 'DEFECTIVE', quality_status_after_code: 'DEFECTIVE' },
    });
    const refused = await decide(returned.nonconformance_id, { dispositionTypeCode: 'SORT', decisionQty: 10 }, 400);
    expect(JSON.stringify(refused.body)).toContain('반품·OQC 부적합에는 선별이 없습니다');
  });

  it('R14a-2 결재 대기 중이던 옛 일부 수량 특채를 적용하면 409 「일부 특채는 지원하지 않습니다」 — 옛 선별·일부 특채 기록은 그대로 조회된다', async () => {
    const nc = await rejectedIqc(1);
    const approval = await prisma.approval_request.create({
      data: { approval_request_no: `${PREFIX}-AR${String(++seq)}`, approval_type_code: 'CONCESSION', target_type_code: 'NONCONFORMANCE',
        target_id: nc.nonconformanceId, requested_by: ids.user, requested_at: new Date(), status_code: 'APPROVED', reason: '옛 일부 특채' },
    });
    const legacy = await prisma.concession.create({
      data: { concession_no: `${PREFIX}-CN${String(seq)}`, nonconformance_id: nc.nonconformanceId, lot_id: BigInt(nc.lots[0].lotId), approved_qty: 6,
        uom_id: ids.ea, valid_from: new Date(`${DAY}T00:00:00Z`), approval_request_id: approval.approval_request_id, status_code: 'PENDING' },
    });
    const refused = await applyConcession(Number(legacy.concession_id)).expect(409);
    expect(JSON.stringify(refused.body)).toContain('일부 특채는 지원하지 않습니다');
    expect((await prisma.concession.findUniqueOrThrow({ where: { concession_id: legacy.concession_id } })).status_code).toBe('PENDING');
    expect(await lotStatuses(nc)).toEqual(['DEFECTIVE']);
    const read = await request(app.getHttpServer()).get(`${CONCESSIONS}/${String(legacy.concession_id)}`).set('Cookie', cookie).expect(200);
    expect(read.body).toMatchObject({ approvedQty: 6, statusCode: 'PENDING' });

    // 옛 선별 판정(수량 분할)도 판정 목록에 그대로 나온다.
    const sorted = await rejectedIqc(1);
    await prisma.disposition_decision.create({
      data: { nonconformance_id: sorted.nonconformanceId, disposition_type_code: 'SORT', decision_qty: 10, uom_id: ids.ea, reason: '옛 선별',
        decided_by: ids.user, decided_at: new Date() },
    });
    const decisions = await request(app.getHttpServer())
      .get(`/api/quality/nonconformances/${String(sorted.nonconformanceId)}/disposition-decisions`).set('Cookie', cookie).expect(200);
    expect((decisions.body.items as { dispositionTypeCode: string }[]).map((item) => item.dispositionTypeCode)).toEqual(['SORT']);
  });

  it('R15-1 재작업 → 같은 IQC 요청 IN_PROGRESS·확정 주기 + 1·REOPENED_BY_REWORK → 재검 결과를 더해 다시 확정하면 LOT 전부 정상', async () => {
    const nc = await rejectedIqc(3);
    const first = await prisma.inspection_result.findFirstOrThrow({ where: { inspection_request_id: BigInt(nc.requestId) } });
    await decide(nc.nonconformanceId, { dispositionTypeCode: 'REWORK', decisionQty: 30 }, 201);

    const reopened = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(nc.requestId) } });
    expect(reopened).toMatchObject({ status_code: 'IN_PROGRESS', confirm_cycle: 2, overall_judgment_code: null, confirmed_at: null, confirmed_by: null });
    const event = await prisma.inspection_request_event.findFirstOrThrow({ where: { inspection_request_id: BigInt(nc.requestId), event_type_code: 'REOPENED_BY_REWORK' } });
    expect(event.summary_before).toMatchObject({ statusCode: 'COMPLETED', overallJudgmentCode: 'REJECTED', nonconformanceId: Number(nc.nonconformanceId) });
    // 앞 확정의 결과는 그 판정의 근거로 확정 그대로 남는다(재검사 결과로만 다시 판정).
    expect((await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: first.inspection_result_id } })).status_code).toBe('CONFIRMED');
    expect(await lotStatuses(nc)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING', 'INSPECTION_PENDING']);

    // 2026-11-12: 매칭 필수·불합격을 덮으니 재검 사유 필수 — LOT 전부를 다시 본다.
    const again = await addResult(nc.requestId, { inspectedQty: 30, acceptedQty: 30, matchedLotIds: lotIdsOf(nc), reinspectionReasonCode: REASON });
    expect((await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(again) } })).confirm_cycle).toBe(2);
    const confirmed = await confirm(nc.requestId);
    expect(confirmed.body).toMatchObject({ statusCode: 'COMPLETED', overallJudgmentCode: 'ACCEPTED' });
    expect(await lotStatuses(nc)).toEqual(['NORMAL', 'NORMAL', 'NORMAL']);
    expect(await openInspectionHolds(nc)).toBe(0);
    expect(await prisma.nonconformance.count({ where: { inspection_request_id: BigInt(nc.requestId) } })).toBe(1);
  });

  it('R15-1 재작업 뒤 재검 불합격이면 새 부적합이 LOT 전부로 선다 — 앞 부적합은 닫혀 있다', async () => {
    const nc = await rejectedIqc(2);
    await decide(nc.nonconformanceId, { dispositionTypeCode: 'REWORK', decisionQty: 20 }, 201);
    await addResult(nc.requestId, { inspectedQty: 20, acceptedQty: 0, rejectedQty: 20, overallJudgmentCode: 'REJECTED', matchedLotIds: lotIdsOf(nc) });
    const confirmed = await confirm(nc.requestId);
    expect(confirmed.body).toMatchObject({ overallJudgmentCode: 'REJECTED' });
    const ncs = await prisma.nonconformance.findMany({
      where: { inspection_request_id: BigInt(nc.requestId) }, orderBy: { nonconformance_id: 'asc' }, include: { nonconformance_lot: true },
    });
    expect(ncs.map((row) => row.status_code)).toEqual(['DECIDED', 'PENDING_DECISION']);
    expect(ncs[1].nonconformance_lot.map((row) => Number(row.lot_id)).sort()).toEqual(nc.lots.map((lot) => lot.lotId).sort());
    expect(await lotStatuses(nc)).toEqual(['DEFECTIVE', 'DEFECTIVE']);
  });

  it('R15-2 재열기 뒤 앞 확정 결과는 CONFIRMED·고칠 수 없고, 재검이 매칭한 LOT 만 새 결과로 판정 — 다시 보지 않은 불합격 LOT 은 불합격, 모두 재검 합격이면 합격·부적합 없음', async () => {
    const iqc = await iqcLot(3);
    const [l1, l2, l3] = lotIdsOf(iqc);
    const first = await addResult(iqc.requestId, { inspectedQty: 30, acceptedQty: 0, rejectedQty: 30, overallJudgmentCode: 'REJECTED', matchedLotIds: [l1, l2, l3] });
    await confirm(iqc.requestId);
    const firstNc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) } });
    await decide(firstNc.nonconformance_id, { dispositionTypeCode: 'REWORK', decisionQty: 30 }, 201);

    // 앞 확정 결과는 확정 그대로 — 고치기·지우기 409.
    const kept = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(first) } });
    expect(kept.status_code).toBe('CONFIRMED');
    await resultCall('put', first, kept.version_no).send({ remarks: '고침' }).expect(409);
    await resultCall('delete', first, kept.version_no).expect(409);
    expect(await detailOf(iqc.requestId)).toMatchObject({ statusCode: 'IN_PROGRESS', nonconformanceId: null, nonconformanceNo: null });

    // 재검(합격, LOT 1·2) — 불합격을 덮으니 사유가 필요하다.
    await request(app.getHttpServer()).post(RESULTS).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx))
      .send(resultBody(iqc.requestId, { inspectedQty: 20, acceptedQty: 20, matchedLotIds: [l1, l2] })).expect(400);
    const retest = await addResult(iqc.requestId, { inspectedQty: 20, acceptedQty: 20, matchedLotIds: [l1, l2], reinspectionReasonCode: REASON });
    const preview = await detailOf(iqc.requestId);
    expect(preview.previewJudgmentCode).toBe('REJECTED');
    expect((preview.lotJudgments as { lotId: number; judgmentCode: string; resultId: number; superseded: { resultId: number }[] }[])
      .map((lot) => [lot.lotId, lot.judgmentCode, lot.resultId, lot.superseded.map((result) => result.resultId)]))
      .toEqual([[l1, 'ACCEPTED', retest, [first]], [l2, 'ACCEPTED', retest, [first]], [l3, 'REJECTED', first, []]]);

    const reconfirmed = await confirm(iqc.requestId);
    expect(reconfirmed.body).toMatchObject({ statusCode: 'COMPLETED', overallJudgmentCode: 'REJECTED' });
    expect(await lotStatuses(iqc)).toEqual(['DEFECTIVE', 'DEFECTIVE', 'DEFECTIVE']);
    const ncs = await prisma.nonconformance.findMany({ where: { inspection_request_id: BigInt(iqc.requestId) }, orderBy: { nonconformance_id: 'asc' } });
    expect(ncs.map((row) => row.status_code)).toEqual(['DECIDED', 'PENDING_DECISION']);
    // 결과 연결 = LOT 판정에 쓰인 불합격 결과(LOT 3 의 결과 1) 중 순번 최소.
    expect(ncs[1].inspection_result_id).toBe(BigInt(first));
    expect(await detailOf(iqc.requestId)).toMatchObject({ nonconformanceId: Number(ncs[1].nonconformance_id), nonconformanceNo: ncs[1].nonconformance_no });

    // LOT 3 도 재검 합격 → 종합 합격, 요청 상세에는 지금 확정이 만든 부적합이 없으니 null(앞의 닫힌 부적합이 아니다).
    await decide(ncs[1].nonconformance_id, { dispositionTypeCode: 'REWORK', decisionQty: 30 }, 201);
    await addResult(iqc.requestId, { matchedLotIds: [l3], reinspectionReasonCode: REASON });
    const accepted = await confirm(iqc.requestId);
    expect(accepted.body).toMatchObject({ statusCode: 'COMPLETED', overallJudgmentCode: 'ACCEPTED' });
    expect(await lotStatuses(iqc)).toEqual(['NORMAL', 'NORMAL', 'NORMAL']);
    expect(await detailOf(iqc.requestId)).toMatchObject({ statusCode: 'COMPLETED', previewJudgmentCode: 'ACCEPTED', nonconformanceId: null, nonconformanceNo: null });
  });

  it('R16-1 IQC 생략 — 입하 중 409 · 마감된 입하 LOT 단위 결재(대상 입하 LOT) · 실행하면 LOT 전부 C22·요청 SKIPPED', async () => {
    const supplier = await newSupplier();
    const { inboundLot, lots } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: supplier, itemId: Number(ids.item), lotQty: 10, lotCount: 3 });
    const receiving = await requestSkip(lots[1].lotId).expect(409);
    expect(receiving.body.errors).toEqual([expect.objectContaining({ code: 'INBOUND_LOT_RECEIVING' })]);

    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const accepted = await requestSkip(lots[2].lotId).expect(202);
    expectShape(schemaOf('logistics', '/trace/lots/{lotId}:request-iqc-skip', 'post', 202), accepted.body);
    expect(accepted.body).toEqual({
      approvalRequestId: expect.any(Number) as number, inboundLotId: inboundLot.inboundLotId, inboundLotNo: inboundLot.inboundLotNo, lotCount: 3,
    });
    const approvalRequestId = accepted.body.approvalRequestId as number;
    const approval = await prisma.approval_request.findUniqueOrThrow({ where: { approval_request_id: BigInt(approvalRequestId) } });
    expect(approval).toMatchObject({ approval_type_code: 'IQC_SKIP', target_type_code: 'INBOUND_LOT', target_id: BigInt(inboundLot.inboundLotId) });
    // 같은 입하 LOT 의 다른 자재 관리 LOT 으로 다시 요청해도 진행 중 결재가 막는다.
    await requestSkip(lots[0].lotId).expect(400);

    await decideApproval(approvalRequestId, 'approve');
    const minLotId = Math.min(...lots.map((lot) => lot.lotId));
    const executed = await request(app.getHttpServer()).post(`/api/trace/lots/${String(minLotId)}:skip-iqc`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).send({}).expect(200);
    expectShape(schemaOf('logistics', '/trace/lots/{lotId}:skip-iqc', 'post', 200), executed.body);
    expect(executed.body).toMatchObject({ inboundLotNo: inboundLot.inboundLotNo, lotCount: 3 });

    const after = await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) }, include: { lot_hold: { where: { released_at: null } } } });
    expect(after.map((lot) => [lot.status_code, lot.lot_hold.length])).toEqual([['NORMAL', 0], ['NORMAL', 0], ['NORMAL', 0]]);
    expect(await prisma.lot_status_event.count({ where: { lot_id: { in: after.map((lot) => lot.lot_id) }, transition_code: 'C22' } })).toBe(3);
    const iqc = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(closed.iqcRequestId as number) } });
    expect(iqc).toMatchObject({ status_code: 'SKIPPED', skip_basis_code: 'APPROVAL' });
    expect(await prisma.inspection_request_event.count({ where: { inspection_request_id: iqc.inspection_request_id, event_type_code: 'SKIPPED' } })).toBe(1);
  });

  it('R16-1 W-01-02 결재 목록·상세의 대상에 targetLotId(그 입하 LOT 의 가장 작은 자재 관리 LOT id)·입하 LOT 번호', async () => {
    const supplier = await newSupplier();
    const { inboundLot, lots } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: supplier, itemId: Number(ids.item), lotQty: 10, lotCount: 2 });
    await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const accepted = await requestSkip(lots[1].lotId).expect(202);
    const approvalRequestId = accepted.body.approvalRequestId as number;
    const target = { targetTypeCode: 'INBOUND_LOT', targetId: inboundLot.inboundLotId, targetLotId: Math.min(...lots.map((lot) => lot.lotId)),
      displayName: `입하 LOT · ${inboundLot.inboundLotNo}` };

    const detail = await request(app.getHttpServer()).get(`${APPROVALS}/${String(approvalRequestId)}`).set('Cookie', approverCookie).expect(200);
    expect(detail.body.request.target).toMatchObject(target);
    const list = await request(app.getHttpServer()).get(APPROVALS).query({ targetTypeCode: 'INBOUND_LOT', targetId: inboundLot.inboundLotId })
      .set('Cookie', cookie).expect(200);
    expect((list.body.items as { approvalRequestId: number; target: unknown }[]).find((item) => item.approvalRequestId === approvalRequestId)?.target)
      .toMatchObject(target);
  });

  it('D18-1 대시보드 「재검 투입」·「재검 OK 복원율」은 확정 주기 2 이상의 결과만 센다', async () => {
    const before = await fullReinspect();
    const nc = await rejectedIqc(2);
    expect(await fullReinspect()).toEqual(before);
    await decide(nc.nonconformanceId, { dispositionTypeCode: 'REWORK', decisionQty: 20 }, 201);
    await addResult(nc.requestId, { inspectedQty: 20, acceptedQty: 15, rejectedQty: 5, overallJudgmentCode: 'REJECTED', matchedLotIds: lotIdsOf(nc) });
    await confirm(nc.requestId);
    expect(await fullReinspect()).toEqual({ inputQty: before.inputQty + 20, restoredQty: before.restoredQty + 15 });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function newSupplier(): Promise<number> {
    supplierSeq += 1;
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-S${String(supplierSeq)}`, partner_name: `${PREFIX} 공급사 ${String(supplierSeq)}` } });
    return Number(supplier.partner_id);
  }

  async function iqcLot(lotCount: number): Promise<IqcLot> {
    const { inboundLot, lots } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: await newSupplier(), itemId: Number(ids.item), lotQty: 10, lotCount });
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    if (closed.iqcRequestId === null) throw new Error('입하 마감이 IQC 요청을 세우지 않았다');
    return { requestId: closed.iqcRequestId, inboundLotId: inboundLot.inboundLotId, lots };
  }

  /** 불합격 확정까지 — 결과 하나(첫 LOT 에 매칭), 확정이 부적합(LOT 전부)을 세운다. */
  async function rejectedIqc(lotCount: number): Promise<Rejected> {
    const iqc = await iqcLot(lotCount);
    const qty = 10 * lotCount;
    await addResult(iqc.requestId, { inspectedQty: qty, acceptedQty: 0, rejectedQty: qty, overallJudgmentCode: 'REJECTED', matchedLotIds: [iqc.lots[0].lotId] });
    await confirm(iqc.requestId);
    const nc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId), status_code: 'PENDING_DECISION' } });
    return { ...iqc, nonconformanceId: nc.nonconformance_id };
  }

  function resultBody(requestId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      inspectionRequestId: requestId, inspectedQty: 10, acceptedQty: 10, rejectedQty: 0, heldQty: 0, uomId: Number(ids.ea),
      inspectedAt: `${DAY}T06:00:00.000Z`, statusCode: 'DRAFT', overallJudgmentCode: 'ACCEPTED', ...overrides,
    };
  }

  async function addResult(requestId: number, overrides: Record<string, unknown> = {}): Promise<number> {
    const response = await request(app.getHttpServer()).post(RESULTS).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx))
      .send(resultBody(requestId, overrides)).expect(201);
    return response.body.inspectionResultId as number;
  }

  function resultCall(method: 'put' | 'delete', resultId: number, version: number): request.Test {
    return request(app.getHttpServer())[method](`${RESULTS}/${String(resultId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(version)}"`);
  }

  async function detailOf(requestId: number): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer()).get(`${REQUESTS}/${String(requestId)}`).set('Cookie', cookie).expect(200);
    expectShape(schemaOf('quality', '/quality/inspection-requests/{inspectionRequestId}', 'get', 200), response.body);
    return response.body as Record<string, unknown>;
  }

  function lotIdsOf(iqc: IqcLot): number[] {
    return iqc.lots.map((lot) => lot.lotId);
  }

  async function confirm(requestId: number): Promise<request.Response> {
    const { version_no: versionNo } = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } });
    return request(app.getHttpServer()).post(`${REQUESTS}/${String(requestId)}:confirm`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo }).expect(200);
  }

  async function decide(nonconformanceId: bigint, body: Record<string, unknown>, status: number): Promise<request.Response> {
    const { version_no: version } = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nonconformanceId } });
    return request(app.getHttpServer()).post(`/api/quality/nonconformances/${String(nonconformanceId)}/disposition-decisions`)
      .set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(version)}"`)
      .send({ uomId: Number(ids.ea), reason: '처분', ...body }).expect(status);
  }

  function requestConcession(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer()).post(CONCESSIONS).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx))
      .send({ uomId: Number(ids.ea), validFrom: DAY, reason: '외관 경미 — 조건부 사용', ...body });
  }

  function applyConcession(concessionId: number): request.Test {
    return request(app.getHttpServer()).post(`${CONCESSIONS}/${String(concessionId)}:apply`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).send({});
  }

  function requestSkip(lotId: number): request.Test {
    return request(app.getHttpServer()).post(`/api/trace/lots/${String(lotId)}:request-iqc-skip`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('X-Worker-No', WORKER_NO).send({ reason: '긴급 출하분 IQC 생략' });
  }

  async function decideApproval(approvalRequestId: number, action: 'approve' | 'reject'): Promise<void> {
    const detail = await request(app.getHttpServer()).get(`${APPROVALS}/${String(approvalRequestId)}`).set('Cookie', approverCookie).expect(200);
    await request(app.getHttpServer()).post(`${APPROVALS}/${String(approvalRequestId)}:${action}`).set('Cookie', approverCookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', String(detail.headers.etag))
      .send(action === 'reject' ? { comment: 'e2e 반려' } : {}).expect(200);
  }

  async function fullReinspect(): Promise<{ inputQty: number; restoredQty: number }> {
    const response = await request(app.getHttpServer()).get('/api/app/dashboard-summary')
      .query({ baseDate: DAY, plantId: ids.plant.toString() }).set('Cookie', cookie).expect(200);
    return (response.body as { quality: { iqc: { fullReinspect: { inputQty: number; restoredQty: number } } } }).quality.iqc.fullReinspect;
  }

  async function inboundLotNoOf(iqc: IqcLot): Promise<string> {
    return (await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(iqc.inboundLotId) } })).inbound_lot_no;
  }

  async function lotStatuses(iqc: IqcLot): Promise<string[]> {
    const lots = await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(iqc.inboundLotId) }, orderBy: { lot_no: 'asc' } });
    return lots.map((lot) => lot.status_code);
  }

  async function openInspectionHolds(iqc: IqcLot): Promise<number> {
    return prisma.lot_hold.count({ where: { lot_id: { in: iqc.lots.map((lot) => BigInt(lot.lotId)) }, reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null } });
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '입하처분법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '입하처분사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '입하처분공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '입하처분자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
  }

  async function makeUser(suffix: string, permissions: string[], workerNo: string): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `${PREFIX} ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    if (workerNo === WORKER_NO) ids.user = user.app_user_id;
    else ids.approver = user.app_user_id;
    await prisma.worker.create({
      data: { worker_no: workerNo, worker_name: `입하처분 ${suffix}`, business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: user.app_user_id, status_code: 'EMPLOYED' },
    });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const results = `SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`;
    const ncs = `SELECT nonconformance_id FROM quality.nonconformance WHERE item_id IN (${items})`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const approvals = `SELECT approval_request_id FROM app.approval_request WHERE requested_by IN (${users}) OR approval_request_no LIKE '${PREFIX}%'`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'LOT' AND aggregate_id IN (${lots}))
         OR (aggregate_type_code = 'APPROVAL_REQUEST' AND aggregate_id IN (${approvals}))`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM quality.defect_record WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.concession WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM app.approval_step WHERE approval_request_id IN (${approvals})`,
      `DELETE FROM app.approval_request WHERE approval_request_id IN (${approvals})`,
      `DELETE FROM app.approval_route_step WHERE approver_user_id IN (${users})`,
      `DELETE FROM app.approval_route WHERE approval_type_code IN ('CONCESSION', 'IQC_SKIP')
         AND NOT EXISTS (SELECT 1 FROM app.approval_route_step s WHERE s.approval_route_id = approval_route.approval_route_id)`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_measurement WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.lot_four_m_change WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM audit.audit_event WHERE target_type_code = 'APPROVAL_REQUEST' AND target_id IN (${approvals})`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      ...(keyList === '' ? [] : [`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`]),
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
