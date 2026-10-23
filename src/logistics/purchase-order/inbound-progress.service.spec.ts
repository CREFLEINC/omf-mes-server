import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { receivableQtyOf } from '../goods-receipt/lot-receivable';
import { InboundProgressService } from './inbound-progress.service';

jest.mock('../goods-receipt/lot-receivable', () => ({ receivableQtyOf: jest.fn() }));

type Args = Record<string, unknown>;
const at = (iso: string): Date => new Date(iso);
const decimal = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

/** 입하 라인 하나(LOT 10) — 검사 대상, 입하 전표 IR-1. */
const inboundLine = (overrides: Args = {}): Args => ({
  inbound_receipt_line_id: 7n,
  purchase_order_line_id: 3n,
  lot_id: 10n,
  inspection_required: true,
  purchase_order_line: { purchase_order_id: 1n },
  inbound_receipt: {
    inbound_receipt_id: 5n,
    inbound_receipt_no: 'IR-1',
    receipt_datetime: at('2026-10-22T01:00:00.000Z'),
    status_code: 'REGISTERED',
  },
  ...overrides,
});

const lotRow = (lotId: bigint, lotNo: string, statusCode: string, qty: string): Args => ({
  lot_id: lotId,
  lot_no: lotNo,
  initial_qty: decimal(qty),
  status_code: statusCode,
  uom: { uom_code: 'EA' },
});

interface Fixture {
  lines?: Args[];
  children?: Args[];
  lots?: Args[];
  receivable?: [bigint, string][];
  requests?: Args[];
  holds?: Args[];
  names?: Args[];
  receipts?: Args[];
}

/** 서비스가 부르는 질의만 답한다 — DB 가 `orderBy` 로 돌려줄 순서 그대로 넣는다. */
function service(fixture: Fixture): InboundProgressService {
  jest.mocked(receivableQtyOf).mockResolvedValue(
    new Map((fixture.receivable ?? []).map(([lotId, qty]) => [lotId, decimal(qty)])),
  );
  const prisma = {
    purchase_order: {
      findUnique: async ({ where }: { where: Args }) =>
        where.purchase_order_id === 1 ? { purchase_order_id: 1n } : null,
    },
    inbound_receipt_line: { findMany: async () => fixture.lines ?? [inboundLine()] },
    lot: {
      findMany: async ({ where }: { where: { parent_lot_id?: { in: bigint[] } } }) =>
        where.parent_lot_id === undefined
          ? (fixture.lots ?? [])
          : (fixture.children ?? []).filter((child) => where.parent_lot_id?.in.includes(child.parent_lot_id as bigint)),
    },
    inspection_request: { findMany: async () => fixture.requests ?? [] },
    lot_hold: { findMany: async () => fixture.holds ?? [] },
    code_value: { findMany: async () => fixture.names ?? [] },
    goods_receipt_line: { findMany: async () => fixture.receipts ?? [] },
  };
  return new InboundProgressService(prisma as unknown as PrismaService);
}

const request = (id: bigint, lotId: bigint, statusCode: string, judgment?: string): Args => ({
  inspection_request_id: id,
  inspection_request_no: `IRQ-${id}`,
  status_code: statusCode,
  requested_at: at('2026-10-22T02:00:00.000Z'),
  lot_id: lotId,
  inspection_result:
    judgment === undefined ? [] : [{ overall_judgment_code: judgment, confirmed_at: at('2026-10-22T03:00:00.000Z') }],
});

const task = (id: bigint, statusCode: string, completedAt: string | null): Args => ({
  putaway_task_id: id,
  putaway_task_no: `PT-${id}`,
  status_code: statusCode,
  completed_at: completedAt === null ? null : at(completedAt),
  location_putaway_task_actual_location_idTolocation:
    completedAt === null ? null : { location_code: 'A-01', location_name: '랙 A-01' },
});

const receiptLine = (lotId: bigint, id: bigint, statusCode: string, tasks: Args[]): Args => ({
  lot_id: lotId,
  goods_receipt: {
    goods_receipt_id: id,
    goods_receipt_no: `GR-${id}`,
    receipt_datetime: at('2026-10-22T04:00:00.000Z'),
    status_code: statusCode,
  },
  putaway_task: tasks,
});

describe('InboundProgressService — 발주 하나의 LOT 진행(장부 P-110)', () => {
  it('없는 발주는 404 다', async () => {
    await expect(service({}).ofPurchaseOrder(2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('선별 자식 LOT 은 조상 입하 라인을 따르고, 자기 의뢰가 없으면 조상의 의뢰를 보여 준다', async () => {
    const rows = await service({
      children: [{ lot_id: 11n, parent_lot_id: 10n }],
      lots: [lotRow(10n, 'L-10', 'NORMAL', '35'), lotRow(11n, 'L-10-S1', 'DEFECTIVE', '15')],
      receivable: [[10n, '35'], [11n, '15']],
      requests: [request(90n, 10n, 'COMPLETED', 'HELD')],
    }).ofPurchaseOrder(1);
    expect(rows.map((row) => [row.lotNo, row.inboundReceiptLineId, row.purchaseOrderLineId, row.stageCode])).toEqual([
      ['L-10', 7, 3, 'RECEIPT_READY'],
      ['L-10-S1', 7, 3, 'RECEIPT_READY'],
    ]);
    expect(rows[1].inspection).toMatchObject({ inspectionRequestNo: 'IRQ-90', judgmentCode: 'HELD' });
    expect(rows[1]).toMatchObject({ receivedQty: 15, receivableQty: 15, uomCode: 'EA', lotStatusCode: 'DEFECTIVE' });
  });

  it('의뢰가 여럿이면 가장 최근 것이다 — 판정은 의뢰가 끝났을 때만 싣는다', async () => {
    const [row] = await service({
      lots: [lotRow(10n, 'L-10', 'INSPECTION_PENDING', '50')],
      receivable: [[10n, '50']],
      requests: [request(91n, 10n, 'IN_PROGRESS', 'ACCEPTED'), request(90n, 10n, 'COMPLETED', 'HELD')],
    }).ofPurchaseOrder(1);
    expect(row.stageCode).toBe('INSPECTION_IN_PROGRESS');
    expect(row.inspection).toMatchObject({ inspectionRequestId: 91, judgmentCode: null, judgedAt: null });
  });

  it('열린 보류 사유는 공통코드 이름으로 실린다 — 같은 사유는 한 번, 이름이 없으면 코드', async () => {
    const [row] = await service({
      lots: [lotRow(10n, 'L-10', 'INSPECTION_PENDING', '50')],
      receivable: [[10n, '50']],
      requests: [request(90n, 10n, 'COMPLETED', 'HELD')],
      holds: [
        { lot_id: 10n, reason_code: 'INCOMING_INSPECTION_WAIT' },
        { lot_id: 10n, reason_code: 'OTHER' },
        { lot_id: 10n, reason_code: 'INCOMING_INSPECTION_WAIT' },
      ],
      names: [{ code: 'INCOMING_INSPECTION_WAIT', code_name: '수입검사 대기' }],
    }).ofPurchaseOrder(1);
    expect(row.stageCode).toBe('INSPECTION_HELD');
    expect(row.blockedReasons).toEqual([
      { code: 'INCOMING_INSPECTION_WAIT', name: '수입검사 대기' },
      { code: 'OTHER', name: 'OTHER' },
    ]);
  });

  it('취소 요청 중인 입고의 적치 작업은 단계에서 빠진다 — 그 입고는 보인다', async () => {
    const [row] = await service({
      lots: [lotRow(10n, 'L-10', 'NORMAL', '50')],
      receivable: [[10n, '0']],
      receipts: [receiptLine(10n, 40n, 'CANCEL_REQUESTED', [task(60n, 'PENDING', null)])],
    }).ofPurchaseOrder(1);
    expect(row.stageCode).toBe('COMPLETED');
    expect(row.goodsReceipt).toMatchObject({ goodsReceiptNo: 'GR-40', statusCode: 'CANCEL_REQUESTED' });
    expect(row.putaway).toBeNull();
  });

  it('적치 줄은 가장 뒤처진 작업이다 — 끝난 작업보다 대기 작업이 앞', async () => {
    const [row] = await service({
      lots: [lotRow(10n, 'L-10', 'NORMAL', '50')],
      receivable: [[10n, '0']],
      receipts: [
        receiptLine(10n, 41n, 'POSTED', [task(61n, 'COMPLETED', '2026-10-22T05:00:00.000Z')]),
        receiptLine(10n, 40n, 'POSTED', [task(60n, 'PENDING', null)]),
      ],
    }).ofPurchaseOrder(1);
    expect(row).toMatchObject({ stageCode: 'PUTAWAY_PENDING', nextActionCode: 'PUTAWAY' });
    expect(row.goodsReceipt?.goodsReceiptNo).toBe('GR-41');
    expect(row.putaway).toMatchObject({ putawayTaskNo: 'PT-60', locationCode: null });
  });

  it('LOT 이 없는 입하 라인은 라벨 대기 줄 하나다 — 수량·단위는 라인의 것이고 LOT 칸은 비어 있다', async () => {
    const rows = await service({
      lines: [inboundLine({ inbound_receipt_line_id: 8n, lot_id: null, received_qty: decimal('120'), uom: { uom_code: 'KG' } }), inboundLine()],
      lots: [lotRow(10n, 'L-10', 'NORMAL', '50')],
      receivable: [[10n, '50']],
    }).ofPurchaseOrder(1);
    expect(rows.map((row) => [row.inboundReceiptLineId, row.lotNo, row.stageCode])).toEqual([
      [8, null, 'LABEL_PENDING'],
      [7, 'L-10', 'RECEIPT_READY'],
    ]);
    expect(rows[0]).toEqual({
      purchaseOrderLineId: 3,
      inboundReceiptId: 5,
      inboundReceiptNo: 'IR-1',
      inboundReceiptLineId: 8,
      receiptDatetime: '2026-10-22T01:00:00.000Z',
      lotId: null,
      lotNo: null,
      receivedQty: 120,
      receivableQty: null,
      uomCode: 'KG',
      lotStatusCode: null,
      stageCode: 'LABEL_PENDING',
      nextActionCode: 'ISSUE_LABEL',
      blockedReasons: [],
      inspection: null,
      goodsReceipt: null,
      putaway: null,
    });
  });

  it('입하 전표가 취소 요청 중이면 CANCELLED 다', async () => {
    const [row] = await service({
      lines: [inboundLine({ inbound_receipt: { ...(inboundLine().inbound_receipt as Args), status_code: 'CANCEL_REQUESTED' } })],
      lots: [lotRow(10n, 'L-10', 'NORMAL', '50')],
      receivable: [[10n, '50']],
    }).ofPurchaseOrder(1);
    expect(row.stageCode).toBe('CANCELLED');
  });
});
