import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService, PreparedInspectionDefects } from '../defect/defect-record-write.service';
import { CONFIRMED_INSPECTION_ONLY } from '../defect/defect-view';
import { prepareDraftDefects, replaceDraftDefectsWithin } from './inspection-rejection-defects';

/** omf-all-around#122 — 작성중 저장(PUT)이 IQC 불합격 사유를 그 회차의 불량 기록으로 갈아 끼운다(장부 P-48). */
const ROW = { defectCodeId: 5, defectQty: 3, defectDescription: '찍힘' };
const PREPARED: PreparedInspectionDefects = { rows: [ROW], processId: 77n, uomId: 2 };

function defectsService() {
  return {
    prepareInspectionDefects: jest.fn().mockResolvedValue(PREPARED),
    writeInspectionDefectsWithin: jest.fn().mockResolvedValue(undefined),
  } as unknown as DefectRecordWriteService & { prepareInspectionDefects: jest.Mock; writeInspectionDefectsWithin: jest.Mock };
}

function prisma(type: string, judgment: string | null) {
  return {
    inspection_result: {
      findUnique: jest.fn().mockResolvedValue({ uom_id: 2n, overall_judgment_code: judgment, inspection_request: { inspection_type_code: type } }),
    },
  } as unknown as PrismaService;
}

function tx(type: string, recordIds: bigint[]) {
  return {
    inspection_result: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ inspection_request: { inspection_type_code: type, lot_id: 30n, work_order_id: null } }),
    },
    defect_record: {
      findMany: jest.fn().mockResolvedValue(recordIds.map((id) => ({ defect_record_id: id }))),
      deleteMany: jest.fn().mockResolvedValue({ count: recordIds.length }),
    },
    repair_result: { count: jest.fn().mockResolvedValue(0) },
    repair_execution: { count: jest.fn().mockResolvedValue(0) },
  };
}

async function errorOf(promise: Promise<unknown>): Promise<ContractException> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ContractException);
  return error as ContractException;
}

describe('prepareDraftDefects', () => {
  it('사유를 싣지 않으면 undefined — 기록에 손대지 않는다', async () => {
    await expect(prepareDraftDefects(prisma('IQC', 'REJECTED'), defectsService(), 8, {})).resolves.toBeUndefined();
  });

  it('빈 배열이면 지우기만 한다', async () => {
    await expect(prepareDraftDefects(prisma('IQC', 'ACCEPTED'), defectsService(), 8, { defects: [] })).resolves.toEqual({ prepared: null });
  });

  it('저장된 판정이 불합격이면 본문 판정이 없어도 받는다', async () => {
    const service = defectsService();
    await expect(prepareDraftDefects(prisma('IQC', 'REJECTED'), service, 8, { defects: [ROW] })).resolves.toEqual({ prepared: PREPARED });
    expect(service.prepareInspectionDefects).toHaveBeenCalledWith([ROW], 2);
  });

  it('합격으로 바꾸는 저장에 사유를 실으면 400 defects INVALID', async () => {
    const error = await errorOf(prepareDraftDefects(prisma('IQC', 'REJECTED'), defectsService(), 8, { overallJudgmentCode: 'ACCEPTED', defects: [ROW] }));
    expect(error.errors[0]).toMatchObject({ field: 'defects', code: 'INVALID' });
  });

  it('IQC 가 아닌 결과에 사유를 실으면 400 defects INVALID', async () => {
    const error = await errorOf(prepareDraftDefects(prisma('PQC', 'REJECTED'), defectsService(), 8, { defects: [ROW] }));
    expect(error.errors[0]).toMatchObject({ field: 'defects', code: 'INVALID' });
  });
});

describe('replaceDraftDefectsWithin', () => {
  const base = { inspectionResultId: 8n, detectedAt: new Date('2026-10-19T00:00:00Z'), actor: { appUserId: 1, workerId: 4n } };

  it('기존 IQC 기록을 지우고 본문 사유로 다시 쓴다', async () => {
    const t = tx('IQC', [11n]);
    const service = defectsService();
    await replaceDraftDefectsWithin(t as unknown as Prisma.TransactionClient, service, { ...base, prepared: PREPARED });

    expect(t.defect_record.deleteMany).toHaveBeenCalledWith({ where: { defect_record_id: { in: [11n] } } });
    expect(service.writeInspectionDefectsWithin).toHaveBeenCalledWith(
      t,
      PREPARED,
      { inspectionResultId: 8n, lotId: 30n, workOrderId: null, detectedAt: base.detectedAt },
      base.actor,
    );
  });

  it('빈 배열이면 지우기만 한다', async () => {
    const t = tx('IQC', [11n]);
    const service = defectsService();
    await replaceDraftDefectsWithin(t as unknown as Prisma.TransactionClient, service, { ...base, prepared: null });

    expect(t.defect_record.deleteMany).toHaveBeenCalled();
    expect(service.writeInspectionDefectsWithin).not.toHaveBeenCalled();
  });

  it('IQC 가 아니면 손대지 않는다', async () => {
    const t = tx('PQC', [11n]);
    await replaceDraftDefectsWithin(t as unknown as Prisma.TransactionClient, defectsService(), { ...base, prepared: null });
    expect(t.defect_record.findMany).not.toHaveBeenCalled();
  });
});

describe('CONFIRMED_INSPECTION_ONLY', () => {
  it('검사 결과가 없는 기록은 남기고, 결과가 있으면 확정된 것만 남긴다', () => {
    expect(CONFIRMED_INSPECTION_ONLY).toEqual({
      OR: [{ inspection_result_id: null }, { inspection_result: { is: { status_code: 'CONFIRMED' } } }],
    });
  });
});
