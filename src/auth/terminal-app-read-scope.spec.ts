import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { assertTerminalAppReadScope, currentTerminalApprovalListScope } from './terminal-app-read-scope';

const terminal = { terminalId: 7n, terminalCode: 'POP-7', plantId: 3n,
  terminalTypeCode: 'POP', equipmentId: 5n };

function request(query: Record<string, unknown> = {}, params: Record<string, string> = {}): Request {
  return { query, params, headers: {} } as unknown as Request;
}

describe('POP app read scope', () => {
  const prisma = {
    lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 43n }) },
    serial_number: { findFirst: jest.fn().mockResolvedValue({ serial_number_id: 51n }) },
    handling_unit: { findUnique: jest.fn().mockResolvedValue({ warehouse: { plant_id: 3n }, location: null }) },
    goods_issue_line: { findFirst: jest.fn().mockResolvedValue({ goods_issue_line_id: 61n }) },
    document_issue_log: { findUnique: jest.fn().mockResolvedValue({
      document_type_code: 'MATERIAL_LOT_LABEL', target_type_code: 'LOT', target_id: 43n,
    }) },
    shipment_lot_allocation: { findFirst: jest.fn().mockResolvedValue({ shipment_lot_allocation_id: 71n }) },
  } as unknown as PrismaService;

  it('checks every summary target and denies a foreign one', async () => {
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'LOT', targetIds: ['43', '44'] }),
      'GET /app/document-issues/summary', terminal)).resolves.toBeUndefined();
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'LOT', targetIds: ['44'] }),
      'GET /app/document-issues/summary', terminal)).rejects.toMatchObject({ status: 401 });
  });

  /**
   * ⭐ D7 — 계약이 `explode: false` 로 적어 `targetIds=1,2,3` 한 문자열로 온다. 이 가드는 계약
   * 검증 «앞»이라 아직 안 나뉜 값을 본다. 전에는 그것을 id 하나로 보아 자기 공장 전표인데도
   * 401 이었다(POP `P-01-02` 대기 목록이 통째로 막혔다).
   */
  it('⭐ 쉼표로 직렬화된 summary 대상을 나눠 본다 — 남의 것이 섞이면 여전히 401 이다', async () => {
    const line = prisma.goods_issue_line.findFirst as jest.Mock;
    line.mockClear();

    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'GOODS_ISSUE_LINE', targetIds: '1,2,3' }),
      'GET /app/document-issues/summary', terminal)).resolves.toBeUndefined();
    expect(line).toHaveBeenCalledTimes(3);
    expect(line.mock.calls.map(([args]) => args.where.goods_issue_line_id)).toEqual([1n, 2n, 3n]);

    // 셋 중 하나가 남의 공장이면 전건을 막는다.
    line.mockResolvedValueOnce({ goods_issue_line_id: 1n }).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'GOODS_ISSUE_LINE', targetIds: '1,2,3' }),
      'GET /app/document-issues/summary', terminal)).rejects.toMatchObject({ status: 401 });

    // 토큰 하나라도 id 가 아니면 막는다.
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'GOODS_ISSUE_LINE', targetIds: '1,,3' }),
      'GET /app/document-issues/summary', terminal)).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'GOODS_ISSUE_LINE', targetIds: '1,-2' }),
      'GET /app/document-issues/summary', terminal)).rejects.toMatchObject({ status: 401 });

    // ⛔ 이미 배열로 온 값은 원소 안의 쉼표를 다시 나누지 않는다 — 계약 검증기와 같은 규칙이다.
    //    (여기서 더 나누면 계약 검증이 400 으로 가를 값을 이 가드가 먼저 통과시킨다.)
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'GOODS_ISSUE_LINE', targetIds: ['1', '2,3'] }),
      'GET /app/document-issues/summary', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('requires a target for issue history and the owned target for a rendition', async () => {
    await expect(assertTerminalAppReadScope(prisma, request(),
      'GET /app/document-issues', terminal)).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '9' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).resolves.toBeUndefined();
    (prisma.document_issue_log.findUnique as jest.Mock).mockResolvedValueOnce({
      document_type_code: 'PACKING_LABEL', target_type_code: 'LOT', target_id: 43n,
    });
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '9' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('binds printer lookup to the current terminal', async () => {
    await expect(assertTerminalAppReadScope(prisma, request({ documentTypeCode: 'GOODS_ISSUE_QR' }),
      'GET /app/printers', terminal)).resolves.toBeUndefined();
    await expect(assertTerminalAppReadScope(prisma, request({ terminalId: '8' }),
      'GET /app/printers', terminal)).rejects.toMatchObject({ status: 401 });
  });

  // ⭐ D2 — 작업 전 점검 게이트(P-02-02)가 단말 공장·W/O 공정으로 «좁혀» 묻는다. 전에는 축이
  //    하나라도 오면 막아 작업 시작 자체가 401 이었다.
  it('takes a narrowed policy lookup but pins plantId to the terminal', async () => {
    // 축을 비운 공구 사용 화면 — 그대로 통과한다.
    await expect(assertTerminalAppReadScope(prisma, request({ policyCode: 'SHOT_CONVERSION_RATIO' }),
      'GET /app/operation-policies/effective', terminal)).resolves.toBeUndefined();
    // 점검 게이트 — 자기 공장 + 공정으로 좁혀 묻는다.
    await expect(assertTerminalAppReadScope(prisma,
      request({ policyCode: 'PRECHECK_CONTROL_LEVEL', plantId: '3', processId: '1' }),
      'GET /app/operation-policies/effective', terminal)).resolves.toBeUndefined();
    // 품목·사업부 축도 형식만 맞으면 받는다.
    await expect(assertTerminalAppReadScope(prisma,
      request({ policyCode: 'PRECHECK_CONTROL_LEVEL', itemId: '9', businessUnitId: '2' }),
      'GET /app/operation-policies/effective', terminal)).resolves.toBeUndefined();
    // ⛔ 남의 공장은 막는다.
    await expect(assertTerminalAppReadScope(prisma, request({ policyCode: 'SHOT_CONVERSION_RATIO', plantId: '8' }),
      'GET /app/operation-policies/effective', terminal)).rejects.toMatchObject({ status: 401 });
    // ⛔ 형식이 아니면 막는다(음수·0·문자).
    for (const axis of [{ processId: '0' }, { itemId: '-1' }, { businessUnitId: 'x' }]) {
      await expect(assertTerminalAppReadScope(prisma,
        request({ policyCode: 'PRECHECK_CONTROL_LEVEL', ...axis }),
        'GET /app/operation-policies/effective', terminal)).rejects.toMatchObject({ status: 401 });
    }
  });

  // ⭐ D5 — POP 이 실적 뒤 생산 LOT 라벨을 찍으려면 이 렌디션을 받아야 하는데 목록에 없어 401 이었다.
  it('takes a production lot label rendition for an owned lot and still denies a foreign one', async () => {
    (prisma.document_issue_log.findUnique as jest.Mock).mockResolvedValueOnce({
      document_type_code: 'PRODUCTION_LOT_LABEL', target_type_code: 'LOT', target_id: 43n,
    });
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '9' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).resolves.toBeUndefined();

    // ⛔ 남의 공장 LOT 이면 막는다 — 대상 소유 검사는 그대로다.
    (prisma.document_issue_log.findUnique as jest.Mock).mockResolvedValueOnce({
      document_type_code: 'PRODUCTION_LOT_LABEL', target_type_code: 'LOT', target_id: 43n,
    });
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '9' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('requires both HU warehouse and location to belong to the terminal plant', async () => {
    (prisma.handling_unit.findUnique as jest.Mock).mockResolvedValueOnce({
      warehouse: { plant_id: 3n }, location: { warehouse: { plant_id: 4n } },
    });
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'HANDLING_UNIT', targetId: '55' }),
      'GET /app/document-issues', terminal)).rejects.toMatchObject({ status: 401 });
  });

  it('allows only an owned delivery allocation rendition', async () => {
    (prisma.document_issue_log.findUnique as jest.Mock).mockResolvedValueOnce({
      document_type_code: 'DELIVERY_LABEL', target_type_code: 'SHIPMENT_LOT_ALLOCATION', target_id: 71n,
    });
    await expect(assertTerminalAppReadScope(prisma, request({}, { documentIssueLogId: '10' }),
      'GET /app/document-issues/{documentIssueLogId}/rendition', terminal)).resolves.toBeUndefined();
    (prisma.shipment_lot_allocation.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma,
      request({ targetTypeCode: 'SHIPMENT_LOT_ALLOCATION', targetId: '71' }),
      'GET /app/document-issues', terminal)).rejects.toMatchObject({ status: 401 });
  });
});

describe('MOBILE approval list scope', () => {
  const mobile = { ...terminal, terminalTypeCode: 'MOBILE' };
  const prisma = {
    lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 43n }) },
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 9n }) },
  } as unknown as PrismaService;

  it('binds the pending query to an inbound LOT in the terminal plant', async () => {
    const req = request({ targetTypeCode: 'INBOUND_LOT', targetId: '43', pendingOnly: 'true', size: '1' });
    await assertTerminalAppReadScope(prisma, req, 'GET /app/approval-requests', mobile);
    expect(currentTerminalApprovalListScope(req)).toEqual({ plantId: 3n, lotId: 43n });
    (prisma.lot.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalAppReadScope(prisma, request({ targetTypeCode: 'INBOUND_LOT', targetId: '44', pendingOnly: 'true', size: '1' }),
      'GET /app/approval-requests', mobile)).rejects.toMatchObject({ status: 401 });
  });

  it('requires an active same-plant worker for my requests', async () => {
    const req = request({ requestedByMe: 'true', size: '20' });
    req.headers = { 'x-worker-no': 'W-9' };
    await assertTerminalAppReadScope(prisma, req, 'GET /app/approval-requests', mobile);
    expect(currentTerminalApprovalListScope(req)).toEqual({ plantId: 3n, workerId: 9n });
    await expect(assertTerminalAppReadScope(prisma, request({ requestedByMe: 'true' }),
      'GET /app/approval-requests', mobile)).rejects.toMatchObject({ status: 401 });
  });
});
