import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { assertTerminalInspectionSheetScope, currentTerminalInspectionSheetWorkerId } from './terminal-inspection-sheet-scope';

/** omf-all-around#89 · 장부 P-102 — POP 제품 검사표 입력은 OA 공장 단말만(담당자 결정 2026-10-21). */
const OPEN = 'POST /quality/inspection-sheets:open-by-serial';

function prisma() {
  return {
    worker: { findFirst: jest.fn().mockResolvedValue({ worker_id: 8n }) },
    code_value: { findMany: jest.fn().mockResolvedValue([{ code: 'PL13' }]) },
    plant: { findMany: jest.fn().mockResolvedValue([{ plant_id: 2n, business_unit_id: 1n }]) },
    serial_number: { findUnique: jest.fn().mockResolvedValue({ lot: { plant_id: 2n } }) },
  } as unknown as PrismaService;
}

const request = () =>
  ({ headers: { 'x-worker-no': 'W-1', 'idempotency-key': 'k-1' }, body: { serialNo: 'SN-1' }, params: {} }) as unknown as Request;
const terminal = (plantId: bigint) => ({ terminalId: 1n, terminalCode: 'T', plantId, terminalTypeCode: 'POP', equipmentId: null });

describe('POP 제품 검사표 단말 범위', () => {
  it('OA 공장 단말은 사번의 작업자로 연다', async () => {
    const req = request();

    await assertTerminalInspectionSheetScope(prisma(), req, OPEN, terminal(2n));

    expect(currentTerminalInspectionSheetWorkerId(req)).toBe(8n);
  });

  it('부품 공장 단말은 403 이다', async () => {
    const error = await assertTerminalInspectionSheetScope(prisma(), request(), OPEN, terminal(1n)).catch((e: unknown) => e);

    expect((error as ContractException).getStatus()).toBe(HttpStatus.FORBIDDEN);
  });
});
