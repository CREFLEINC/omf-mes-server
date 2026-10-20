import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';
import {
  TERMINAL_QUALITY_READ_OPERATIONS,
  assertTerminalQualityReadScope,
  currentTerminalQualityReadScope,
} from './terminal-quality-read-scope';

const terminal = (type: 'POP' | 'MOBILE') => ({
  plantId: 3n, terminalId: 7n, terminalTypeCode: type,
}) as TerminalContext;
const request = (query: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
  ({ query, params }) as unknown as Request;
const prisma = () => ({
  inspection_request: { findFirst: jest.fn().mockResolvedValue({ inspection_request_id: 1n }) },
  nonconformance: { findFirst: jest.fn().mockResolvedValue({ nonconformance_id: 1n }) },
  work_order: { findFirst: jest.fn().mockResolvedValue({ work_order_id: 1n }) },
  lot: { findFirst: jest.fn().mockResolvedValue({ lot_id: 1n }) },
  shipment_request: { findMany: jest.fn().mockResolvedValue([{ shipment_request_id: 31n }]) },
}) as unknown as PrismaService;
const mappedWorkOrder = {
  production_line: { plant_id: 3n },
  routing_operation: { process: { terminal_process: {
    some: { terminal_id: 7n, can_start_work: true },
  } } },
};
const popInspection = { OR: [
  { work_order: mappedWorkOrder },
  { inspection_type_code: 'OQC', OR: [
    { lot: { plant_id: 3n } },
    { target_type_code: 'SHIPMENT_REQUEST', target_id: { in: [31n] } },
  ] },
] };

describe('terminal quality read scope', () => {
  it('contains only the twelve client quality/repair GETs with exact channels', () => {
    // +2 — PQC 패널이 작성중 회차·측정치를 되살린다(omf-all-around#107 · 장부 P-49).
    expect(Object.keys(TERMINAL_QUALITY_READ_OPERATIONS)).toHaveLength(12);
    expect(TERMINAL_QUALITY_READ_OPERATIONS['GET /quality/inspection-results']).toEqual(['POP']);
    expect(TERMINAL_QUALITY_READ_OPERATIONS['GET /quality/inspection-requests']).toEqual(['POP']);
    expect(TERMINAL_QUALITY_READ_OPERATIONS['GET /quality/defect-records']).toEqual(['MOBILE']);
    expect(TERMINAL_QUALITY_READ_OPERATIONS['GET /quality/inspection-plans']).toBeUndefined();
    expect(TERMINAL_QUALITY_READ_OPERATIONS['GET /quality/nonconformances']).toBeUndefined();
  });

  it('requires a POP inspection request to be a mapped W/O request or a same-plant OQC request', async () => {
    const db = prisma();
    const req = request({}, { inspectionRequestId: '42' });
    await assertTerminalQualityReadScope(db, req, 'GET /quality/inspection-requests/{inspectionRequestId}', terminal('POP'));
    expect(db.inspection_request.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ inspection_request_id: 42n }, popInspection] }, select: { inspection_request_id: true },
    });
    expect(currentTerminalQualityReadScope(req)).toMatchObject({ plantId: 3n, terminalId: 7n });
    (db.inspection_request.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalQualityReadScope(db, request({}, { inspectionRequestId: '43' }),
      'GET /quality/inspection-requests/{inspectionRequestId}', terminal('POP'))).rejects.toMatchObject({ status: 401 });
  });

  it('opens the POP OQC queue without a W/O but keeps other W/O-less lists closed', async () => {
    const db = prisma();
    await assertTerminalQualityReadScope(db, request({ inspectionTypeCode: 'OQC' }),
      'GET /quality/inspection-requests', terminal('POP'));
    expect(db.work_order.findFirst).not.toHaveBeenCalled();
    await expect(assertTerminalQualityReadScope(db, request({ inspectionTypeCode: 'PQC' }),
      'GET /quality/inspection-requests', terminal('POP'))).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalQualityReadScope(db, request(),
      'GET /quality/inspection-requests', terminal('POP'))).rejects.toMatchObject({ status: 401 });
  });

  it('opens POP inspection rounds only for one visible inspection request', async () => {
    const db = prisma();
    await assertTerminalQualityReadScope(db, request({ inspectionRequestId: '42' }),
      'GET /quality/inspection-results', terminal('POP'));
    expect(db.inspection_request.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ inspection_request_id: 42n }, popInspection] }, select: { inspection_request_id: true },
    });
    // 측정치는 PQC 패널만 부른다 — 공정 매핑 W/O 의 회차로만 연다(omf-all-around#107).
    await assertTerminalQualityReadScope(db, request({}, { inspectionResultId: '12' }),
      'GET /quality/inspection-results/{inspectionResultId}/measurements', terminal('POP'));
    expect((db.inspection_request.findFirst as jest.Mock).mock.calls[1][0].where).toMatchObject({
      inspection_result: { some: { inspection_result_id: 12n } }, work_order: mappedWorkOrder,
    });
    await expect(assertTerminalQualityReadScope(db, request(),
      'GET /quality/inspection-results', terminal('POP'))).rejects.toMatchObject({ status: 401 });
    await expect(assertTerminalQualityReadScope(db, request({ inspectionRequestId: '42' }),
      'GET /quality/inspection-results', terminal('MOBILE'))).rejects.toMatchObject({ status: 401 });
  });

  it('requires a MOBILE defect LOT in the same plant and leaves shared defect codes global', async () => {
    const db = prisma();
    const req = request({ lotId: '6' });
    await assertTerminalQualityReadScope(db, req, 'GET /quality/defect-records', terminal('MOBILE'));
    expect(db.lot.findFirst).toHaveBeenCalledWith({ where: { lot_id: 6n, plant_id: 3n }, select: { lot_id: true } });
    await assertTerminalQualityReadScope(db, request(), 'GET /quality/defect-codes', terminal('MOBILE'));
    await expect(assertTerminalQualityReadScope(db, request(), 'GET /quality/defect-records', terminal('MOBILE'))).rejects.toMatchObject({ status: 401 });
    // POP 은 P-02-14 자재 불량 등록이 불량 코드를 고른다(장부 P-52).
    await assertTerminalQualityReadScope(db, request(), 'GET /quality/defect-codes', terminal('POP'));
  });

  it('ties POP plan/version/NCR details to an actual mapped inspection or work order', async () => {
    const db = prisma();
    await assertTerminalQualityReadScope(db, request({}, { inspectionPlanVersionId: '71' }),
      'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}/items', terminal('POP'));
    expect(db.inspection_request.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ inspection_plan_version_id: 71n }),
    }));
    await assertTerminalQualityReadScope(db, request({}, { inspectionPlanId: '12' }),
      'GET /quality/inspection-plans/{inspectionPlanId}', terminal('POP'));
    expect(db.inspection_request.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ inspection_plan_version: { inspection_plan_id: 12n } }),
    }));
    await assertTerminalQualityReadScope(db, request({}, { nonconformanceId: '67' }),
      'GET /quality/nonconformances/{nonconformanceId}/disposition-decisions', terminal('POP'));
    expect(db.nonconformance.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ nonconformance_id: 67n,
        work_order_nonconformance_work_order_idTowork_order: expect.objectContaining({ production_line: { plant_id: 3n } }) }),
    }));
    (db.nonconformance.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(assertTerminalQualityReadScope(db, request({}, { nonconformanceId: '68' }),
      'GET /quality/nonconformances/{nonconformanceId}', terminal('POP'))).rejects.toMatchObject({ status: 401 });
  });

  it('limits MOBILE repair queue to open rows and a same-plant scanned LOT when supplied', async () => {
    const db = prisma();
    await assertTerminalQualityReadScope(db, request({ open: 'true' }),
      'GET /production/repair-executions', terminal('MOBILE'));
    await assertTerminalQualityReadScope(db, request({ open: 'true', lotId: '6' }),
      'GET /production/repair-executions', terminal('MOBILE'));
    expect(db.lot.findFirst).toHaveBeenCalledWith({ where: { lot_id: 6n, plant_id: 3n }, select: { lot_id: true } });
    await expect(assertTerminalQualityReadScope(db, request({ open: 'false' }),
      'GET /production/repair-executions', terminal('MOBILE'))).rejects.toMatchObject({ status: 401 });
  });
});
