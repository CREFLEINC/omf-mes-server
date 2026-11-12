/**
 * 피처 005 입하 LOT 시험 도우미(T040) — 자재 관리 LOT 발행 묶음(실제 API) → 스캔마다 `:receive` 한 번(PDA 와 같다) → `:close-receipt`.
 * S7 에서 옛 경로로 입하·LOT 을 만들던 기존 e2e 를 이리로 옮긴다.
 */
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import type { PrismaService } from '../../src/prisma/prisma.service';

const BATCHES = '/api/logistics/material-lot-batches';
const RECEIVE = '/api/logistics/inbound-lots:receive';
const INBOUND_LOTS = '/api/logistics/inbound-lots';
const RESULTS = '/api/quality/inspection-results';
const REQUESTS = '/api/quality/inspection-requests';

/** 요청에 인증을 싣는다 — 단말(토큰 + 작업자 사번) 또는 계정(세션 쿠키). */
export type Authorize = (test: request.Test) => request.Test;

export function terminalAuth(token: string, workerNo: string): Authorize {
  return (test) => test.set('Authorization', `Bearer ${token}`).set('X-Worker-No', workerNo);
}

export function sessionAuth(cookie: string): Authorize {
  return (test) => test.set('Cookie', cookie);
}

export interface IssuedMaterialLot {
  lotId: number;
  lotNo: string;
  lotQty: number;
}

export interface MaterialLotBatchBody {
  plantId: number;
  supplierId: number;
  itemId: number;
  lotQty: number;
  lotCount: number;
  supplierLotNo?: string | null;
  package?: { uomId: number; count: number; qtyPerPackage: number } | null;
}

export interface ReceivedInboundLot {
  inboundLotId: number;
  inboundLotNo: string;
  created: boolean;
  autoClosedInboundLotNo: string | null;
  inboundReceiptNo: string;
  receivedQty: number;
  lotCount: number;
  lots: { lotId: number; lotNo: string; lotQty: number; statusCode: string; fromSupplierLabel: boolean }[];
}

export type ReceiveEntry = { lotId: number } | { lotNo: string; supplierLotNo?: string | null };

export interface InboundLotFixture {
  app: INestApplication;
  /** 발행 묶음을 만드는 쪽 — POP 단말(P-01-01) 또는 W-01-14 계정. */
  issuer: Authorize;
  /** 받는 쪽 — MOBILE 단말(M-01-01) 또는 M-01-01 계정. */
  receiver: Authorize;
  businessDate: string;
  /** 보낸 멱등 키 — 시험이 정리할 때 쓴다. */
  keys?: Set<string>;
  /** 마감하는 쪽 — MOBILE 단말 또는 M-01-01·M-01-03 계정. 없으면 `receiver`. */
  closer?: Authorize;
  /** IQC 결과를 기록(W-01-01)·판정 확정(W-01-15)하는 계정 — `passInboundLotIqc` 가 쓴다. */
  inspector?: Authorize;
  /** `passInboundLotIqc` 가 결과 단위와 확정 효과를 읽는다. */
  prisma?: PrismaService;
}

/** 계약 `InboundLotClosed` 중 시험이 읽는 칸. */
export interface ClosedInboundLot {
  inboundLotId: number;
  inboundLotNo: string;
  statusCode: string;
  receivedQty: number;
  unallocatedQty: number;
  poAllocations: { purchaseOrderLineId: number; purchaseOrderNo: string; lineNo: number; qty: number }[];
  iqcRequestId: number | null;
  versionNo: number;
}

export function idempotencyKey(fixture: Pick<InboundLotFixture, 'keys'>): string {
  const key = randomUUID();
  fixture.keys?.add(key);
  return key;
}

/** 자재 관리 LOT 발행 묶음(`POST /logistics/material-lot-batches`) — 만든 대기 LOT 들(번호 순). */
export async function issueMaterialLots(fixture: InboundLotFixture, body: MaterialLotBatchBody): Promise<{ batchId: number; lots: IssuedMaterialLot[] }> {
  const response = await fixture.issuer(request(fixture.app.getHttpServer()).post(BATCHES))
    .set('Idempotency-Key', idempotencyKey(fixture))
    .send({ businessDate: fixture.businessDate, occurredAt: `${fixture.businessDate}T02:00:00.000Z`, package: null, ...body })
    .expect(201);
  return response.body as { batchId: number; lots: IssuedMaterialLot[] };
}

/** `:receive` 본문 한 벌 — PDA 처럼 스캔 하나. */
export function receiveBody(fixture: Pick<InboundLotFixture, 'businessDate'>, lots: ReceiveEntry[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = `${fixture.businessDate}T03:00:00.000Z`;
  return { receiptDatetime: at, businessDate: fixture.businessDate, occurredAt: at, lots, ...overrides };
}

/** 스캔 하나를 받는다(201 이어야 한다). */
export async function receiveScan(fixture: InboundLotFixture, entry: ReceiveEntry): Promise<ReceivedInboundLot> {
  const response = await fixture.receiver(request(fixture.app.getHttpServer()).post(RECEIVE))
    .set('Idempotency-Key', idempotencyKey(fixture))
    .send(receiveBody(fixture, [entry]))
    .expect(201);
  const [received] = (response.body as { inboundLots: ReceivedInboundLot[] }).inboundLots;
  return received;
}

/** 스캔마다 `:receive` 한 번 — 차례대로. 마지막 응답이 그 입하 LOT 의 누계다. */
export async function receiveScans(fixture: InboundLotFixture, lotIds: number[]): Promise<ReceivedInboundLot[]> {
  const results: ReceivedInboundLot[] = [];
  for (const lotId of lotIds) results.push(await receiveScan(fixture, { lotId }));
  return results;
}

/** 묶음을 만들고 그 LOT 을 모두 받는다 — 입하 중(`RECEIVING`) 입하 LOT 하나가 선다. */
export async function issueAndReceive(fixture: InboundLotFixture, body: MaterialLotBatchBody): Promise<{ lots: IssuedMaterialLot[]; inboundLot: ReceivedInboundLot }> {
  const { lots } = await issueMaterialLots(fixture, body);
  const results = await receiveScans(fixture, lots.map((lot) => lot.lotId));
  return { lots, inboundLot: results[results.length - 1] };
}

/** 입하 마감(`:close-receipt`) — 지금 `versionNo` 를 읽어 보낸다. 200 이어야 한다. */
export async function closeInboundLotFixture(fixture: InboundLotFixture, inboundLotId: number, occurredAt = `${fixture.businessDate}T05:00:00.000Z`): Promise<ClosedInboundLot> {
  const closer = fixture.closer ?? fixture.receiver;
  const current = await closer(request(fixture.app.getHttpServer()).get(`${INBOUND_LOTS}/${String(inboundLotId)}`)).expect(200);
  const response = await closer(request(fixture.app.getHttpServer()).post(`${INBOUND_LOTS}/${String(inboundLotId)}:close-receipt`))
    .set('Idempotency-Key', idempotencyKey(fixture))
    .send({ versionNo: (current.body as { versionNo: number }).versionNo, occurredAt })
    .expect(200);
  return response.body as ClosedInboundLot;
}

/**
 * IQC 합격 자재 관리 LOT 만들기(T040) — 입고·피킹처럼 합격 LOT 이 필요한 시험이 쓰는 하나뿐인 자리.
 * 순서: (입하 중이면) 입하 마감(`:close-receipt` → 입하 LOT IQC 요청) → 그 요청에 합격 결과(작성중) → 요청 `:confirm`(S9 부터 —
 * S5~S8 은 결과 `:confirm`) — 도우미 안에서 LOT 전부 정상·요청 `COMPLETED`·`overall_judgment_code`·`confirmed_at` 을 단언한다.
 * `inspector` 는 W-01-01·W-01-15 를 가진 계정이어야 한다. 검사 불필요 품목으로 돌리는 우회는 쓰지 않는다 — 검사 필요 품목이 아니면 던진다.
 */
export async function passInboundLotIqc(fixture: InboundLotFixture, inboundLotId: number): Promise<IssuedMaterialLot[]> {
  const { inspector, prisma } = fixture;
  if (inspector === undefined || prisma === undefined) throw new Error('passInboundLotIqc: fixture.inspector(W-01-01·W-01-15)·fixture.prisma 가 필요하다');
  const id = BigInt(inboundLotId);
  const inbound = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: id }, select: { status_code: true } });
  if (inbound.status_code === 'RECEIVING') await closeInboundLotFixture(fixture, inboundLotId);
  const iqc = await prisma.inspection_request.findFirst({
    where: { inbound_lot_id: id, inspection_type_code: 'IQC', status_code: { not: 'CANCELLED' } }, select: { inspection_request_id: true, target_qty: true, uom_id: true, status_code: true },
  });
  if (iqc === null || iqc.status_code !== 'REQUESTED') throw new Error(`passInboundLotIqc(${String(inboundLotId)}): 검사할 IQC 요청이 없다 — 검사 필요 품목이어야 한다`);
  const qty = Number(iqc.target_qty);
  // 결과마다 자재 관리 LOT 1개 이상 매칭(2026-11-12) — [전부 선택]처럼 입하 LOT 의 LOT 전부.
  const matched = await prisma.lot.findMany({ where: { inbound_lot_id: id }, select: { lot_id: true }, orderBy: { lot_id: 'asc' } });
  const created = await inspector(request(fixture.app.getHttpServer()).post(RESULTS))
    .set('Idempotency-Key', idempotencyKey(fixture))
    .send({
      inspectionRequestId: Number(iqc.inspection_request_id), inspectedQty: qty, acceptedQty: qty, rejectedQty: 0, heldQty: 0,
      uomId: Number(iqc.uom_id), inspectedAt: `${fixture.businessDate}T06:00:00.000Z`, statusCode: 'DRAFT', overallJudgmentCode: 'ACCEPTED',
      matchedLotIds: matched.map((lot) => Number(lot.lot_id)),
    })
    .expect(201);
  expect((created.body as { statusCode: string }).statusCode).toBe('DRAFT');
  // 판정 확정은 검사 단위(요청 `:confirm` · 권한 W-01-15) — 결과 전부를 한 번에 확정한다(S9 · D-11).
  const requestPath = `${REQUESTS}/${String(iqc.inspection_request_id)}`;
  const current = await inspector(request(fixture.app.getHttpServer()).get(requestPath)).expect(200);
  await inspector(request(fixture.app.getHttpServer()).post(`${requestPath}:confirm`))
    .set('Idempotency-Key', idempotencyKey(fixture))
    .send({ versionNo: (current.body as { versionNo: number }).versionNo })
    .expect(200);

  const confirmed = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: iqc.inspection_request_id } });
  expect(confirmed).toMatchObject({ status_code: 'COMPLETED', overall_judgment_code: 'ACCEPTED' });
  expect(confirmed.confirmed_at).not.toBeNull();
  const lots = await prisma.lot.findMany({ where: { inbound_lot_id: id }, select: { lot_id: true, lot_no: true, initial_qty: true, status_code: true }, orderBy: { lot_no: 'asc' } });
  expect(lots.map((lot) => lot.status_code)).toEqual(lots.map(() => 'NORMAL'));
  return lots.map((lot) => ({ lotId: Number(lot.lot_id), lotNo: lot.lot_no, lotQty: Number(lot.initial_qty) }));
}

/**
 * 결과 매칭 기본값(2026-11-12 매칭 필수) — 입하 LOT 요청(`targetTypeCode=INBOUND_LOT`)이면 결과 차례대로 자재 관리 LOT 하나씩
 * (LOT 번호 순, 결과가 LOT 수보다 많으면 처음부터). 결과끼리 LOT 이 겹치지 않으면 LOT별 마지막 결과 판정이 「결과 전부 중 가장
 * 나쁜 것」과 같아 매칭 없이 쓰던 시험의 뜻이 그대로다. 옛 요청이면 `undefined`(매칭 칸을 싣지 않는다).
 */
export async function defaultMatchedLotIds(prisma: PrismaService, inspectionRequestId: number): Promise<number[] | undefined> {
  const iqc = await prisma.inspection_request.findUniqueOrThrow({
    where: { inspection_request_id: BigInt(inspectionRequestId) }, select: { target_type_code: true, inbound_lot_id: true },
  });
  if (iqc.target_type_code !== 'INBOUND_LOT' || iqc.inbound_lot_id === null) return undefined;
  const [lots, results] = await Promise.all([
    prisma.lot.findMany({ where: { inbound_lot_id: iqc.inbound_lot_id }, select: { lot_id: true }, orderBy: { lot_no: 'asc' } }),
    prisma.inspection_result.count({ where: { inspection_request_id: BigInt(inspectionRequestId) } }),
  ]);
  return lots.length === 0 ? undefined : [Number(lots[results % lots.length].lot_id)];
}
