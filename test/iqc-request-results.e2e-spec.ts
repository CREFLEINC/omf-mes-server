/**
 * 피처 005 S8 — 입하 LOT IQC 결과 목록·매칭·삭제·조회(T062 · omf-all-around#254).
 * 새 흐름 = 요청 `targetTypeCode=INBOUND_LOT`: 결과는 순번·작성중으로만, 자재 관리 LOT 매칭, 확정 전 수정·삭제·이력.
 * 이전된 옛 요청(대상 LOT)은 회차 사슬·결과 단위 확정 그대로(R18-1). 응답은 ajv 로 계약 대조.
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
import {
  IssuedMaterialLot, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'IQRS';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const RESULTS = '/api/quality/inspection-results';
const REQUESTS = '/api/quality/inspection-requests';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object, 'quality');
const schemaOf = (path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `quality#/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});
function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

interface ResultRow { inspectionResultId: number; inspectionRound: number; confirmCycle: number | null; matchedLotIds: number[]; matchedLotNos: string[]; versionNo: number }
interface IqcLot { requestId: number; inboundLotId: number; inboundLotNo: string; lots: IssuedMaterialLot[] }

describe('피처 005 S8 입하 LOT IQC 결과 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let outsider: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let supplierSeq = 0;
  let legacySeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code), true);
    outsider = await makeUser('NOIQC', ['W-03-05'], false);
    const pop = await terminalToken('POP');
    const mobile = await terminalToken('MOBILE');
    fx = { app, issuer: terminalAuth(pop, WORKER_NO), receiver: terminalAuth(mobile, WORKER_NO), businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US3-1 입하 LOT 요청에 지금 양식(측정·수량·판정·불량·4M)으로 결과 1건 — 요청 REQUESTED → IN_PROGRESS, 순번 1·주기 1·작성중', async () => {
    const iqc = await iqcLot(3);
    expect(await requestStatus(iqc.requestId)).toBe('REQUESTED');
    const created = await post(resultBody(iqc.requestId, {
      rejectedQty: 2, acceptedQty: 8, overallJudgmentCode: 'REJECTED',
      measurements: [{ inspectionItemSpecId: Number(ids.spec), sampleNo: 1, numericValue: 1.5, judgmentCode: 'REJECTED', measuredAt: `${DAY}T06:00:00.000Z` }],
      defects: [{ defectCodeId: Number(ids.defectCode), defectQty: 2, defectDescription: '긁힘' }],
      fourMChange: { remarks: '공급사 공정 변경' },
    })).expect(201);
    expectShape(schemaOf('/quality/inspection-results', 'post', 201), created.body);
    expect(created.body).toMatchObject({ statusCode: 'DRAFT', inspectionRound: 1, inspectionRequestId: iqc.requestId });
    const row = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(created.body.inspectionResultId) } });
    expect(row).toMatchObject({ confirm_cycle: 1, inspection_round: 1, previous_result_id: null, reinspection_reason_code: null });
    expect(await requestStatus(iqc.requestId)).toBe('IN_PROGRESS');
    expect(await prisma.inspection_measurement.count({ where: { inspection_result_id: row.inspection_result_id } })).toBe(1);
    expect(await prisma.defect_record.count({ where: { inspection_result_id: row.inspection_result_id } })).toBe(1);
    expect(await prisma.lot_four_m_change.count({ where: { lot_id: { in: iqc.lots.map((lot) => BigInt(lot.lotId)) } } })).toBe(3);
  });

  it('US3-1 회차 칸(previousResultId·reinspectionReasonCode)과 statusCode=CONFIRMED 는 400 — 결과가 서지 않는다', async () => {
    const iqc = await iqcLot(1);
    const first = (await post(resultBody(iqc.requestId)).expect(201)).body.inspectionResultId as number;
    const previous = await post(resultBody(iqc.requestId, { previousResultId: first })).expect(400);
    expect(previous.body.errors).toEqual([expect.objectContaining({ field: 'previousResultId', code: 'INVALID' })]);
    const reason = await post(resultBody(iqc.requestId, { reinspectionReasonCode: 'RETEST' })).expect(400);
    expect(reason.body.errors).toEqual([expect.objectContaining({ field: 'reinspectionReasonCode', code: 'INVALID' })]);
    expect(await resultCount(iqc.requestId)).toBe(1);
  });

  it('R10-3 POP 오프라인 큐의 「태어날 때 확정」(statusCode=CONFIRMED) IQC 는 400 — 결과·LOT 상태 그대로', async () => {
    const iqc = await iqcLot(2);
    const born = await post(resultBody(iqc.requestId, { statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED' })).expect(400);
    expect(born.body.errors).toEqual([expect.objectContaining({ field: 'statusCode', code: 'INVALID' })]);
    expect(await resultCount(iqc.requestId)).toBe(0);
    expect(await requestStatus(iqc.requestId)).toBe('REQUESTED');
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING']);
  });

  it('US3-2·US3-3·US3-4 매칭 — 결과 하나에 LOT 둘, 다른 결과와 겹쳐도 되고, 매칭 없이도 저장된다 · 한 결과에 같은 LOT 두 번은 400', async () => {
    const iqc = await iqcLot(3);
    const [l1, l2] = iqc.lots.map((lot) => lot.lotId);
    await post(resultBody(iqc.requestId)).expect(201);
    await post(resultBody(iqc.requestId, { matchedLotIds: [l1, l2] })).expect(201);
    await post(resultBody(iqc.requestId, { matchedLotIds: [l1] })).expect(201);
    const twice = await post(resultBody(iqc.requestId, { matchedLotIds: [l1, l1] })).expect(400);
    expect(twice.body.errors).toEqual([expect.objectContaining({ field: 'matchedLotIds', code: 'INVALID' })]);

    const results = (await detail(iqc.requestId)).results as ResultRow[];
    expect(results.map((row) => [row.inspectionRound, row.matchedLotIds])).toEqual([[1, []], [2, [l1, l2]], [3, [l1]]]);
    expect(results[1].matchedLotNos).toEqual([iqc.lots[0].lotNo, iqc.lots[1].lotNo]);
  });

  it('US3-7 다른 입하 LOT 의 자재 관리 LOT 매칭은 400 — 만들기·고치기 모두', async () => {
    const iqc = await iqcLot(1);
    const other = await iqcLot(1);
    const foreign = await post(resultBody(iqc.requestId, { matchedLotIds: [other.lots[0].lotId] })).expect(400);
    expect(foreign.body.errors).toEqual([expect.objectContaining({ field: 'matchedLotIds', code: 'INVALID' })]);
    const own = (await post(resultBody(iqc.requestId)).expect(201)).body as ResultRow;
    await put(own.inspectionResultId, own.versionNo, { matchedLotIds: [other.lots[0].lotId] }).expect(400);
  });

  it('US3-5·FR-024 상세 — lots[]·results[]·poAllocations 참고·previewJudgmentCode=REJECTED, 기록만으로 LOT 상태는 그대로', async () => {
    const iqc = await iqcLot(2);
    await post(resultBody(iqc.requestId, { matchedLotIds: [iqc.lots[0].lotId] })).expect(201);
    await post(resultBody(iqc.requestId, { acceptedQty: 7, rejectedQty: 3, overallJudgmentCode: 'REJECTED', matchedLotIds: [iqc.lots[1].lotId] })).expect(201);

    const body = await detail(iqc.requestId);
    expect(body).toMatchObject({
      targetTypeCode: 'INBOUND_LOT', inboundLotId: iqc.inboundLotId, inboundLotNo: iqc.inboundLotNo, lotCount: 2, confirmCycle: 1,
      previewJudgmentCode: 'REJECTED', poAllocations: [], unallocatedQty: 20, statusCode: 'IN_PROGRESS',
    });
    expect(body.lots).toEqual(iqc.lots.map((lot) => ({ lotId: lot.lotId, lotNo: lot.lotNo, lotQty: 10, package: null, statusCode: 'INSPECTION_PENDING' })));
    expect((body.results as ResultRow[]).map((row) => row.confirmCycle)).toEqual([1, 1]);
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING']);
    expect(await prisma.lot_status_event.count({ where: { lot_id: { in: iqc.lots.map((lot) => BigInt(lot.lotId)) }, source_document_type_code: 'INSPECTION_RESULT' } })).toBe(0);

    // 판정이 빈 결과가 끼면 미리 보기는 없다(확정할 수 없음).
    await post(resultBody(iqc.requestId, { overallJudgmentCode: undefined })).expect(201);
    expect((await detail(iqc.requestId)).previewJudgmentCode).toBeNull();
  });

  it('목록 — inboundLotId 조건·행 inboundLotId·inboundLotNo·lotCount, 확정 전에는 overallJudgmentCode·confirmedAt 이 없다', async () => {
    const iqc = await iqcLot(3);
    const listed = await get(`${REQUESTS}?inboundLotId=${String(iqc.inboundLotId)}`).expect(200);
    expectShape(schemaOf('/quality/inspection-requests', 'get', 200), listed.body);
    expect(listed.body.items).toEqual([expect.objectContaining({
      inspectionRequestId: iqc.requestId, inboundLotId: iqc.inboundLotId, inboundLotNo: iqc.inboundLotNo, lotCount: 3,
    })]);
    expect(listed.body.items[0]).not.toHaveProperty('overallJudgmentCode');
    expect(listed.body.items[0]).not.toHaveProperty('confirmedAt');
  });

  it('US3-6 PUT 수정(수량·판정·매칭 갈아 끼움) → DELETE(측정·초안 불량·매칭 함께) — 이력 RESULT_ADDED·UPDATED·DELETED 전·후 요약', async () => {
    const iqc = await iqcLot(2);
    const [l1, l2] = iqc.lots.map((lot) => lot.lotId);
    const created = (await post(resultBody(iqc.requestId, {
      matchedLotIds: [l1], acceptedQty: 9, rejectedQty: 1, overallJudgmentCode: 'REJECTED',
      measurements: [{ inspectionItemSpecId: Number(ids.spec), sampleNo: 1, numericValue: 2, judgmentCode: 'ACCEPTED', measuredAt: `${DAY}T06:00:00.000Z` }],
      defects: [{ defectCodeId: Number(ids.defectCode), defectQty: 1 }],
    })).expect(201)).body as ResultRow;

    const updated = await put(created.inspectionResultId, created.versionNo, { acceptedQty: 10, rejectedQty: 0, overallJudgmentCode: 'ACCEPTED', defects: [], matchedLotIds: [l1, l2] }).expect(200);
    expectShape(schemaOf('/quality/inspection-results/{inspectionResultId}', 'put', 200), updated.body);
    const [row] = (await detail(iqc.requestId)).results as ResultRow[];
    expect(row).toMatchObject({ matchedLotIds: [l1, l2], overallJudgmentCode: 'ACCEPTED', acceptedQty: 10, versionNo: created.versionNo + 1 });

    const id = BigInt(created.inspectionResultId);
    await remove(created.inspectionResultId, row.versionNo).expect(204);
    expect(await prisma.inspection_result.count({ where: { inspection_result_id: id } })).toBe(0);
    expect(await prisma.inspection_measurement.count({ where: { inspection_result_id: id } })).toBe(0);
    expect(await prisma.inspection_result_lot.count({ where: { inspection_result_id: id } })).toBe(0);
    expect(await prisma.defect_record.count({ where: { inspection_result_id: id } })).toBe(0);

    const history = await get(`${REQUESTS}/${String(iqc.requestId)}/history`).expect(200);
    expectShape(schemaOf('/quality/inspection-requests/{inspectionRequestId}/history', 'get', 200), history.body);
    const changes = (history.body.events as { eventTypeCode: string; inspectionResultId?: number; summaryBefore?: Record<string, unknown>; summaryAfter?: Record<string, unknown>; actorName?: string }[])
      .filter((event) => event.eventTypeCode.startsWith('RESULT_') && event.eventTypeCode !== 'RESULT_SAVED' && event.eventTypeCode !== 'RESULT_CONFIRMED');
    expect(changes.map((event) => event.eventTypeCode)).toEqual(['RESULT_ADDED', 'RESULT_UPDATED', 'RESULT_DELETED']);
    expect(changes.every((event) => event.inspectionResultId === created.inspectionResultId && event.actorName === `${PREFIX} ALL`)).toBe(true);
    expect(changes[0].summaryAfter).toMatchObject({ inspectionRound: 1, overallJudgmentCode: 'REJECTED', matchedLotIds: [l1] });
    expect(changes[1].summaryBefore).toMatchObject({ overallJudgmentCode: 'REJECTED', rejectedQty: 1, matchedLotIds: [l1] });
    expect(changes[1].summaryAfter).toMatchObject({ overallJudgmentCode: 'ACCEPTED', rejectedQty: 0, matchedLotIds: [l1, l2] });
    expect(changes[2].summaryBefore).toMatchObject({ inspectionRound: 1, matchedLotIds: [l1, l2] });
    expect(changes[2]).not.toHaveProperty('summaryAfter');
  });

  it('US3-6 순번 = 최대 + 1 — 마지막 결과를 지워도 그 번호를 다시 쓰지 않는다', async () => {
    const iqc = await iqcLot(1);
    await post(resultBody(iqc.requestId)).expect(201);
    const second = (await post(resultBody(iqc.requestId)).expect(201)).body as ResultRow;
    expect(second.inspectionRound).toBe(2);
    await remove(second.inspectionResultId, second.versionNo).expect(204);
    const third = (await post(resultBody(iqc.requestId)).expect(201)).body as ResultRow;
    expect(third.inspectionRound).toBe(3);
  });

  it('US3-6 DELETE 409 — 수리 이력이 있는 불량 기록, 이전된 옛 요청의 결과 · 낡은 If-Match 는 409 VERSION_CONFLICT', async () => {
    const iqc = await iqcLot(1);
    const created = (await post(resultBody(iqc.requestId, { rejectedQty: 1, acceptedQty: 9, overallJudgmentCode: 'REJECTED', defects: [{ defectCodeId: Number(ids.defectCode), defectQty: 1 }] })).expect(201)).body as ResultRow;
    await remove(created.inspectionResultId, created.versionNo + 5).expect(409);
    const defect = await prisma.defect_record.findFirstOrThrow({ where: { inspection_result_id: BigInt(created.inspectionResultId) } });
    await prisma.repair_result.create({
      data: { repair_result_no: `${PREFIX}-RR-${String(created.inspectionResultId)}`, defect_record_id: defect.defect_record_id, repair_type_code: 'REWORK',
        repair_qty: 1, uom_id: ids.ea, result_code: 'OK', repaired_at: new Date() },
    });
    const repaired = await remove(created.inspectionResultId, created.versionNo).expect(409);
    expect(repaired.body).toMatchObject({ code: 'INVALID_STATE' });
    expect(await prisma.inspection_result.count({ where: { inspection_result_id: BigInt(created.inspectionResultId) } })).toBe(1);

    const legacy = await legacyIqc(5);
    const old = (await post(resultBody(legacy.requestId, { inspectedQty: 5, acceptedQty: 5 })).expect(201)).body as ResultRow;
    expect(await remove(old.inspectionResultId, old.versionNo).expect(409)).toMatchObject({ body: { code: 'INVALID_STATE' } });
  });

  it('R12-1 불량 기록의 LOT — 매칭 LOT 이 하나면 그 LOT, 둘이거나 없으면 NULL · 매칭을 고치면 따라 바뀐다', async () => {
    const iqc = await iqcLot(2);
    const [l1, l2] = iqc.lots.map((lot) => lot.lotId);
    const rejected = { acceptedQty: 9, rejectedQty: 1, overallJudgmentCode: 'REJECTED', defects: [{ defectCodeId: Number(ids.defectCode), defectQty: 1 }] };
    const single = (await post(resultBody(iqc.requestId, { ...rejected, matchedLotIds: [l1] })).expect(201)).body as ResultRow;
    const both = (await post(resultBody(iqc.requestId, { ...rejected, matchedLotIds: [l1, l2] })).expect(201)).body as ResultRow;
    const none = (await post(resultBody(iqc.requestId, rejected)).expect(201)).body as ResultRow;
    expect(await defectLot(single.inspectionResultId)).toBe(BigInt(l1));
    expect(await defectLot(both.inspectionResultId)).toBeNull();
    expect(await defectLot(none.inspectionResultId)).toBeNull();

    await put(both.inspectionResultId, both.versionNo, { matchedLotIds: [l2] }).expect(200);
    expect(await defectLot(both.inspectionResultId)).toBe(BigInt(l2));

    // 결과에 따로 다는 불량 기록(POST /quality/defect-records)도 같은 규칙 — 그 입하 LOT 밖의 LOT 은 400.
    const separate = await sendDefect({ inspectionResultId: single.inspectionResultId }).expect(201);
    expect(separate.body.lotId).toBe(l1);
    const other = await iqcLot(1);
    await sendDefect({ inspectionResultId: single.inspectionResultId, lotId: other.lots[0].lotId }).expect(400);
  });

  it('판정 확정된 요청(결과 단위 확정 — S8 까지 열림)에는 결과 추가·수정·삭제가 409 INVALID_STATE', async () => {
    const iqc = await iqcLot(1);
    const draft = (await post(resultBody(iqc.requestId)).expect(201)).body as ResultRow;
    const toConfirm = (await post(resultBody(iqc.requestId)).expect(201)).body as ResultRow;
    await request(app.getHttpServer()).post(`${RESULTS}/${String(toConfirm.inspectionResultId)}:confirm`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(toConfirm.versionNo)}"`).send({ overallJudgmentCode: 'ACCEPTED' }).expect(200);
    expect(await requestStatus(iqc.requestId)).toBe('COMPLETED');

    expect((await post(resultBody(iqc.requestId)).expect(409)).body).toMatchObject({ code: 'INVALID_STATE' });
    expect((await put(draft.inspectionResultId, draft.versionNo, { remarks: '늦음' }).expect(409)).body).toMatchObject({ code: 'INVALID_STATE' });
    expect((await remove(draft.inspectionResultId, draft.versionNo).expect(409)).body).toMatchObject({ code: 'INVALID_STATE' });
    const listed = await get(`${REQUESTS}?inboundLotId=${String(iqc.inboundLotId)}`).expect(200);
    expect(listed.body.items[0]).toMatchObject({ overallJudgmentCode: 'ACCEPTED', confirmedAt: expect.any(String) });
  });

  it('권한 W-01-01 — 없으면 결과 추가·수정·삭제 403', async () => {
    const iqc = await iqcLot(1);
    const created = (await post(resultBody(iqc.requestId)).expect(201)).body as ResultRow;
    await post(resultBody(iqc.requestId), outsider).expect(403);
    await put(created.inspectionResultId, created.versionNo, { remarks: '권한' }, outsider).expect(403);
    await remove(created.inspectionResultId, created.versionNo, outsider).expect(403);
  });

  it('R18-1 이전된 옛 요청(대상 LOT·inbound_lot_id 있음)에는 거절이 걸리지 않는다 — 회차 사슬·결과 단위 확정 그대로, 매칭 칸은 400', async () => {
    const legacy = await legacyIqc(5);
    await post(resultBody(legacy.requestId, { inspectedQty: 5, acceptedQty: 5, matchedLotIds: [legacy.lotId] })).expect(400);
    const first = (await post(resultBody(legacy.requestId, { inspectedQty: 5, acceptedQty: 5 })).expect(201)).body as ResultRow;
    const second = (await post(resultBody(legacy.requestId, { inspectedQty: 5, acceptedQty: 5, previousResultId: first.inspectionResultId })).expect(201)).body as ResultRow;
    expect(second.inspectionRound).toBe(2);
    expect((await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(second.inspectionResultId) } })).confirm_cycle).toBeNull();
    await request(app.getHttpServer()).post(`${RESULTS}/${String(second.inspectionResultId)}:confirm`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(second.versionNo)}"`).send({ overallJudgmentCode: 'ACCEPTED' }).expect(200);
    const confirmed = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(legacy.requestId) } });
    expect(confirmed).toMatchObject({ status_code: 'COMPLETED', overall_judgment_code: 'ACCEPTED' });
    expect(confirmed.confirmed_at).not.toBeNull();
    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(legacy.lotId) } })).status_code).toBe('NORMAL');
    // 옛 요청 상세에는 입하 LOT 검사 칸(lots·results)이 없다.
    const body = await detail(legacy.requestId);
    expect(body).not.toHaveProperty('results');
    expect(body).toMatchObject({ inboundLotId: Number(legacy.inboundLotId), lotCount: 1 });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function iqcLot(lotCount: number): Promise<IqcLot> {
    supplierSeq += 1;
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-S${String(supplierSeq)}`, partner_name: `${PREFIX} 공급사 ${String(supplierSeq)}` } });
    const { inboundLot, lots } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: Number(supplier.partner_id), itemId: Number(ids.item), lotQty: 10, lotCount });
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    if (closed.iqcRequestId === null) throw new Error('입하 마감이 IQC 요청을 세우지 않았다');
    return { requestId: closed.iqcRequestId, inboundLotId: inboundLot.inboundLotId, inboundLotNo: inboundLot.inboundLotNo, lots };
  }

  /** 이전된 옛 IQC 요청 — 대상 LOT·`lot_id` 있음·`inbound_lot_id` 만 채움(데이터 이전 3). */
  async function legacyIqc(qty: number): Promise<{ requestId: number; lotId: number; inboundLotId: bigint }> {
    legacySeq += 1;
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-LS${String(legacySeq)}`, partner_name: `${PREFIX} 옛 공급사` } });
    const at = new Date(`${DAY}T02:00:00.000Z`);
    const receipt = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-L${String(legacySeq)}`, supplier_id: supplier.partner_id, plant_id: ids.plant, receipt_datetime: at, status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: receipt.inbound_receipt_id, line_no: 1, item_id: ids.item, received_qty: qty, uom_id: ids.ea,
        supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
    });
    const inbound = await prisma.inbound_lot.create({
      data: { inbound_lot_no: `IL-MIG-${String(line.inbound_receipt_line_id)}`, plant_id: ids.plant, item_id: ids.item, supplier_id: supplier.partner_id, uom_id: ids.ea,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: at, erp_send_mode_code: 'PER_RECEIPT',
        inbound_receipt_line_id: line.inbound_receipt_line_id },
    });
    const lot = await prisma.lot.create({
      data: { lot_no: `${PREFIX}-LEGACY-${String(legacySeq)}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty, uom_id: ids.ea,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'INSPECTION_PENDING', inbound_lot_id: inbound.inbound_lot_id },
    });
    await prisma.lot_hold.create({
      data: { lot_id: lot.lot_id, reason_code: 'INCOMING_INSPECTION_WAIT', status_code: 'HELD', target_lot_status_code: 'INSPECTION_PENDING', held_by: ids.user, held_at: at },
    });
    const iqc = await prisma.inspection_request.create({
      data: { inspection_request_no: `${PREFIX}-IQC-L${String(legacySeq)}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lot.lot_id,
        item_id: ids.item, lot_id: lot.lot_id, inbound_lot_id: inbound.inbound_lot_id, target_qty: qty, uom_id: ids.ea, status_code: 'REQUESTED', requested_at: at },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id }, data: { lot_id: lot.lot_id } });
    return { requestId: Number(iqc.inspection_request_id), lotId: Number(lot.lot_id), inboundLotId: inbound.inbound_lot_id };
  }

  function resultBody(requestId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const body: Record<string, unknown> = {
      inspectionRequestId: requestId, inspectedQty: 10, acceptedQty: 10, rejectedQty: 0, heldQty: 0, uomId: Number(ids.ea),
      inspectedAt: `${DAY}T06:00:00.000Z`, statusCode: 'DRAFT', overallJudgmentCode: 'ACCEPTED', ...overrides,
    };
    return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  }

  function post(body: Record<string, unknown>, as = cookie): request.Test {
    return request(app.getHttpServer()).post(RESULTS).set('Cookie', as).set('Idempotency-Key', idempotencyKey(fx)).send(body);
  }

  function put(resultId: number, version: number, body: Record<string, unknown>, as = cookie): request.Test {
    return request(app.getHttpServer()).put(`${RESULTS}/${String(resultId)}`).set('Cookie', as)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(version)}"`).send(body);
  }

  function remove(resultId: number, version: number, as = cookie): request.Test {
    return request(app.getHttpServer()).delete(`${RESULTS}/${String(resultId)}`).set('Cookie', as)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(version)}"`);
  }

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  function sendDefect(overrides: Record<string, unknown>): request.Test {
    return request(app.getHttpServer()).post('/api/quality/defect-records').set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx))
      .send({ sourceCode: 'IQC', defectCodeId: Number(ids.defectCode), defectQty: 1, uomId: Number(ids.ea), detectedAt: `${DAY}T06:10:00.000Z`, ...overrides });
  }

  async function detail(requestId: number): Promise<Record<string, unknown>> {
    const response = await get(`${REQUESTS}/${String(requestId)}`).expect(200);
    expectShape(schemaOf('/quality/inspection-requests/{inspectionRequestId}', 'get', 200), response.body);
    return response.body as Record<string, unknown>;
  }

  async function requestStatus(requestId: number): Promise<string> {
    return (await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } })).status_code;
  }

  async function resultCount(requestId: number): Promise<number> {
    return prisma.inspection_result.count({ where: { inspection_request_id: BigInt(requestId) } });
  }

  async function lotStatuses(iqc: IqcLot): Promise<string[]> {
    const lots = await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(iqc.inboundLotId) }, orderBy: { lot_no: 'asc' } });
    return lots.map((lot) => lot.status_code);
  }

  async function defectLot(resultId: number): Promise<bigint | null> {
    return (await prisma.defect_record.findFirstOrThrow({ where: { inspection_result_id: BigInt(resultId) } })).lot_id;
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '결과목록법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '결과목록사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '결과목록공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '결과목록자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    ids.otherItem = (await prisma.item.create({
      data: { item_code: `${PREFIX}-X`, item_name: '결과목록기준용', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: false },
    })).item_id;
    ids.defectCode = (await prisma.defect_code.create({ data: { defect_code: `${PREFIX}-DEF`, defect_name: '결과목록불량' } })).defect_code_id;
    // 측정치의 항목 FK 만 필요하다 — 이 품목의 IQC 요청이 이 기준을 집지 않게 다른 품목에 둔다.
    const plan = await prisma.inspection_plan.create({
      data: { inspection_plan_code: `${PREFIX}-PLAN`, inspection_plan_name: '결과목록기준', item_id: ids.otherItem, inspection_type_code: 'IQC' },
    });
    const version = await prisma.inspection_plan_version.create({
      data: { inspection_plan_id: plan.inspection_plan_id, plan_version: 1, effective_from: new Date('2026-01-01T00:00:00.000Z'),
        sampling_method_code: 'FULL', inspection_frequency_code: 'EVERY_LOT', status_code: 'DRAFT' },
    });
    ids.spec = (await prisma.inspection_item_spec.create({
      data: { inspection_plan_version_id: version.inspection_plan_version_id, sequence_no: 1, inspection_item_code: 'LEN', inspection_item_name: '길이', data_type_code: 'NUMERIC', uom_id: ids.ea },
    })).inspection_item_spec_id;
  }

  async function makeUser(suffix: string, permissions: string[], withWorker: boolean): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `${PREFIX} ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    if (withWorker) {
      ids.user = user.app_user_id;
      await prisma.worker.create({
        data: { worker_no: WORKER_NO, worker_name: '결과목록검사자', business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: user.app_user_id, status_code: 'EMPLOYED' },
      });
    }
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
    const defects = `SELECT defect_record_id FROM quality.defect_record WHERE defect_code_id IN (SELECT defect_code_id FROM quality.defect_code WHERE defect_code LIKE '${PREFIX}%')`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))
         OR (aggregate_type_code = 'LOT' AND aggregate_id IN (${lots}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM quality.repair_result WHERE defect_record_id IN (${defects})`,
      `DELETE FROM quality.defect_record WHERE defect_record_id IN (${defects})`,
      `DELETE FROM quality.nonconformance_lot WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_measurement WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.lot_four_m_change WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_item_spec WHERE inspection_plan_version_id IN (SELECT inspection_plan_version_id FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'))`,
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%')`,
      `DELETE FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'`,
      `DELETE FROM quality.defect_code WHERE defect_code LIKE '${PREFIX}%'`,
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
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      ...(keyList === '' ? [] : [`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`]),
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
