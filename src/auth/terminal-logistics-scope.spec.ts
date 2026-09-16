import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';
import {
  TERMINAL_LOGISTICS_OPERATIONS,
  assertTerminalLogisticsScope,
  currentTerminalLogisticsWorkerId,
} from './terminal-logistics-scope';

const mobile: TerminalContext = {
  terminalId: 7n, terminalCode: 'M-7', plantId: 3n, terminalTypeCode: 'MOBILE', equipmentId: null,
};
const pop: TerminalContext = { ...mobile, terminalTypeCode: 'POP' };
const request = (params: Record<string, string> = {}, body: unknown = {}, query: Record<string, unknown> = {}, workerNo = 'W-3') => ({
  params, body, query, header: (key: string) => key === 'X-Worker-No' ? workerNo : undefined,
}) as unknown as Request;
const prisma = (overrides: Record<string, unknown> = {}) => ({
  worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 5n, app_user_id: 9n }) },
  warehouse: { findFirst: jest.fn().mockResolvedValue({ warehouse_id: 4n }) },
  location: { findFirst: jest.fn().mockResolvedValue({ location_id: 6n }) },
  lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 8n }) },
  goods_issue: { findFirst: jest.fn().mockResolvedValue({ goods_issue_id: 11n }) },
  picking_order: { findFirst: jest.fn().mockResolvedValue({ picking_order_id: 12n }) },
  picking_line: { findFirst: jest.fn().mockResolvedValue({ picking_line_id: 13n }) },
  ...overrides,
}) as unknown as PrismaService;

describe('terminal logistics scope', () => {
  it('enumerates the client logistics surface and denies an unlisted operation or channel', async () => {
    expect(Object.keys(TERMINAL_LOGISTICS_OPERATIONS)).toHaveLength(43);
    // ⛔ 쓰기는 `DELETE` 도 센다 — 상자 제거가 첫 DELETE 다(SHIP-UNIT-02). 작업자 사번을
    //    요구하는 집합이 곧 이 집합이라, 동사 목록이 어긋나면 그 자리가 401 로 막힌다.
    expect(Object.keys(TERMINAL_LOGISTICS_OPERATIONS).filter(
      (key) => key.startsWith('POST ') || key.startsWith('PUT ') || key.startsWith('DELETE '),
    )).toHaveLength(18);
    await expect(assertTerminalLogisticsScope(prisma(), request(), 'POST /logistics/shipments', mobile)).rejects.toBeDefined();
    await expect(assertTerminalLogisticsScope(prisma(), request(), 'POST /logistics/goods-issues', pop)).rejects.toBeDefined();
  });

  // ⭐ SHIP-FINAL-01 D2 — 읽기·생성만 열어 두어 첫 상자 스캔이 401 로 막혔다. 세 경로를
  //    한 벌로 잠근다. 하나라도 빠지면 「열고 → 담고 → 마감」 흐름이 중간에서 끊긴다.
  it('출하 단위의 쓰기 셋은 POP 에 열려 있고 모바일에는 닫혀 있다', async () => {
    const writes = [
      'POST /logistics/shipping-units/{shippingUnitId}:add-box',
      'DELETE /logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}',
      'POST /logistics/shipping-units/{shippingUnitId}:close',
    ];
    for (const key of writes) {
      expect(TERMINAL_LOGISTICS_OPERATIONS[key]).toEqual(['POP']);
      await expect(assertTerminalLogisticsScope(prisma(), request(), key, mobile)).rejects.toBeDefined();
    }
  });

  it('상자 제거는 DELETE 인데도 작업자를 심는다 — 안 심으면 쓰기 행위자가 401 이다', async () => {
    const db = prisma({
      shipping_unit: { findFirst: jest.fn().mockResolvedValue({ shipping_unit_id: 1n }) },
      shipping_unit_handling_unit: { findFirst: jest.fn().mockResolvedValue({ handling_unit_id: 2n }) },
    });
    const req = request({ shippingUnitId: '1', handlingUnitId: '2' });
    await assertTerminalLogisticsScope(db, req,
      'DELETE /logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}', pop);
    expect(currentTerminalLogisticsWorkerId(req)).toBe(5n);
  });

  it('남의 단위에 든 상자는 공장이 같아도 빼내지 못한다', async () => {
    const db = prisma({
      shipping_unit: { findFirst: jest.fn().mockResolvedValue({ shipping_unit_id: 1n }) },
      shipping_unit_handling_unit: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(assertTerminalLogisticsScope(db, request({ shippingUnitId: '1', handlingUnitId: '2' }),
      'DELETE /logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}', pop)).rejects.toBeDefined();
    expect(db.shipping_unit_handling_unit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { handling_unit_id: 2n, shipping_unit_id: 1n },
    }));
  });

  it('다른 공장의 출하 단위에는 상자를 담지 못한다', async () => {
    const db = prisma({ shipping_unit: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(assertTerminalLogisticsScope(db, request({ shippingUnitId: '1' }, { handlingUnitId: 2 }),
      'POST /logistics/shipping-units/{shippingUnitId}:add-box', pop)).rejects.toBeDefined();
    expect(db.shipping_unit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { shipping_unit_id: 1n, shipment: { warehouse: { plant_id: 3n } } },
    }));
  });

  it('rejects another plant goods issue before detail is returned', async () => {
    const db = prisma({ goods_issue: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(assertTerminalLogisticsScope(db, request({ goodsIssueId: '11' }), 'GET /logistics/goods-issues/{goodsIssueId}', pop)).rejects.toBeDefined();
    expect(db.goods_issue.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { goods_issue_id: 11n, warehouse: { plant_id: 3n } },
    }));
  });

  it('requires an active same-plant worker for writes and attaches the worker', async () => {
    const body = { sourceDocumentTypeCode: 'PICKING_ORDER', sourceDocumentId: 12, sourceWarehouseId: 4, lines: [{ lotId: 8, sourceLocationId: 6 }] };
    const missing = prisma({ worker: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(assertTerminalLogisticsScope(missing, request({}, body), 'POST /logistics/goods-issues', mobile)).rejects.toBeDefined();
    const req = request({}, body);
    await assertTerminalLogisticsScope(prisma(), req, 'POST /logistics/goods-issues', mobile);
    expect(currentTerminalLogisticsWorkerId(req)).toBe(5n);
  });

  it('연결 계정이 없는 활성 작업자도 허용하고 재생재 공장은 본문의 창고로 판정한다', async () => {
    const db = prisma({ worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 28n, app_user_id: null }) } });
    const req = request({}, { itemId: 10, quantity: 1, warehouseId: 4, locationId: 6 });
    await assertTerminalLogisticsScope(db, req, 'POST /logistics/recycle-entries', mobile);
    expect(currentTerminalLogisticsWorkerId(req)).toBe(28n);
    expect(db.warehouse.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { warehouse_id: 4n, plant_id: 3n },
    }));
    expect(db.worker.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { worker_no: 'W-3', plant_id: 3n, is_active: true },
    }));
  });

  it('checks nested line locations and lots before a write', async () => {
    const db = prisma({ location: { findFirst: jest.fn().mockResolvedValue(null) } });
    const body = { sourceDocumentTypeCode: 'PICKING_ORDER', sourceDocumentId: 12, sourceWarehouseId: 4, lines: [{ lotId: 8, sourceLocationId: 99 }] };
    await expect(assertTerminalLogisticsScope(db, request({}, body), 'POST /logistics/goods-issues', mobile)).rejects.toBeDefined();
    expect(db.location.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { location_id: 99n, warehouse: { plant_id: 3n } },
    }));
  });

  it('rejects an unshipped request before product picking because it has no plant owner', async () => {
    const db = prisma({ shipment_request: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(assertTerminalLogisticsScope(
      db,
      request({ shipmentRequestId: '21', shipmentRequestLineId: '22' }, { lotId: 8 }),
      'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick',
      mobile,
    )).rejects.toBeDefined();
    expect(db.shipment_request.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { shipment_request_id: 21n, fulfillment_plant_id: 3n },
    }));
  });

  it('takes the goods issue list from both POP and mobile and still pins a queried plant', async () => {
    // P-01-02 는 출고번호로 전표를 찾아 들어간다(U3) — 라인 QR 은 `goodsIssueLineId` 축으로 푼다.
    for (const terminal of [pop, mobile]) {
      await assertTerminalLogisticsScope(prisma(), request({}, {}, { q: 'GI-20260916-0001' }), 'GET /logistics/goods-issues', terminal);
      await assertTerminalLogisticsScope(prisma(), request({}, {}, { goodsIssueLineId: '17' }), 'GET /logistics/goods-issues', terminal);
      await expect(assertTerminalLogisticsScope(prisma(), request({}, {}, { plantId: '4' }), 'GET /logistics/goods-issues', terminal)).rejects.toBeDefined();
    }
  });

  it('requires a picking line to belong to the order in the path', async () => {
    const db = prisma({ picking_line: { findFirst: jest.fn().mockResolvedValue(null) } });
    await expect(assertTerminalLogisticsScope(db, request({ pickingOrderId: '12', pickingLineId: '13' }), 'POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick', mobile)).rejects.toBeDefined();
    expect(db.picking_line.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { picking_line_id: 13n, picking_order_id: 12n },
    }));
  });
});
