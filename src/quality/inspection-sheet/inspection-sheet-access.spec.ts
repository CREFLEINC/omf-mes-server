import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { attachSession } from '../../auth/session-resolver.service';
import { attachTerminal } from '../../auth/terminal-context';
import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionSheetAccess } from './inspection-sheet-access';

/** omf-all-around#89 · 장부 P-102 — 검사표 화면·API 는 OA 공장 범위만(담당자 결정 2026-10-21). */
function access(sheetPlant: bigint | null = 2n) {
  const prisma = {
    code_value: { findMany: jest.fn().mockResolvedValue([{ code: 'PL13' }]) },
    plant: {
      findMany: jest.fn().mockResolvedValue([{ plant_id: 2n, business_unit_id: 1n }]),
    },
    inspection_sheet: {
      findUnique: jest.fn().mockResolvedValue(sheetPlant === null ? null : { lot: { plant_id: sheetPlant } }),
    },
    serial_number: { findUnique: jest.fn().mockResolvedValue({ lot: { plant_id: sheetPlant } }) },
  };
  return new InspectionSheetAccess(prisma as unknown as PrismaService);
}

const sessionRequest = (scopes: { businessUnitId: number; plantId?: number }[]) => {
  const request = { headers: {} } as Request;
  attachSession(request, { userId: 7, loginId: 'u', userName: 'u', scopes, roles: [], permissions: [], mustChangePassword: false, worker: null });
  return request;
};

const status = async (promise: Promise<unknown>) =>
  ((await promise.catch((e: unknown) => e)) as ContractException).getStatus();

describe('InspectionSheetAccess', () => {
  it('OA 공장 범위 계정은 그 공장을 쓴다', async () => {
    await expect(access().plantsOf(sessionRequest([{ businessUnitId: 1, plantId: 2 }]))).resolves.toEqual([2n]);
  });

  it('부품 공장 범위만 있는 계정은 403 「이 화면은 OA 사업부 전용입니다」다', async () => {
    const error = await access()
      .plantsOf(sessionRequest([{ businessUnitId: 1, plantId: 1 }]))
      .catch((e: unknown) => e);

    expect((error as ContractException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect((error as ContractException).errors[0]?.message).toBe('이 화면은 OA 사업부 전용입니다.');
  });

  it('단말 요청은 단말 공장을 쓴다(OA 여부는 단말 범위가 먼저 본다)', async () => {
    const request = { headers: {} } as Request;
    attachTerminal(request, { terminalId: 1n, terminalCode: 'T', plantId: 2n, terminalTypeCode: 'POP', equipmentId: null });

    await expect(access().plantsOf(request)).resolves.toEqual([2n]);
  });

  it('다른 공장 LOT 의 검사표·시리얼은 403 이다', async () => {
    await expect(status(access(1n).assertSheet(9, [2n]))).resolves.toBe(HttpStatus.FORBIDDEN);
    await expect(status(access(1n).assertSerial('SN-1', [2n]))).resolves.toBe(HttpStatus.FORBIDDEN);
    await expect(access(2n).assertSheet(9, [2n])).resolves.toBeUndefined();
  });
});
