/**
 * 피처 005 입하 LOT 시험 도우미(T040) — 자재 관리 LOT 발행 묶음(실제 API) → 스캔마다 `:receive` 한 번(PDA 와 같다).
 * S5 에서 `:close-receipt` 를, S7 에서 옛 경로로 입하·LOT 을 만들던 기존 e2e 를 이리로 옮긴다.
 */
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

const BATCHES = '/api/logistics/material-lot-batches';
const RECEIVE = '/api/logistics/inbound-lots:receive';

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

/**
 * IQC 합격 자재 관리 LOT 만들기(T040) — 입고·피킹처럼 합격 LOT 이 필요한 시험이 쓰는 하나뿐인 자리.
 * 순서: 받기 → 입하 마감(`:close-receipt` → 입하 LOT IQC 요청) → 그 요청에 합격 결과 → 결과 `:confirm`(S5~S8) — 도우미 안에서
 * LOT 전부 정상·요청 `COMPLETED`·`overall_judgment_code`·`confirmed_at` 을 단언한다. S9 에서 요청 단위 `:confirm` 으로 바꾼다
 * (바꾸는 곳은 여기 하나). 검사 불필요 품목으로 돌리는 우회는 쓰지 않는다.
 * ⚠ S4 에는 입하 마감(`:close-receipt`, S5)이 없어 입하 LOT IQC 요청이 생기지 않는다 — 지금은 만들 수 없어 던진다.
 */
export function passInboundLotIqc(fixture: InboundLotFixture, inboundLotId: number): Promise<IssuedMaterialLot[]> {
  return Promise.reject(new Error(
    `passInboundLotIqc(${String(inboundLotId)}): 입하 마감(:close-receipt)이 S5 에서 생긴다 — ${String(fixture.businessDate)} 의 입하 LOT 을 아직 IQC 로 넘길 수 없다`,
  ));
}
