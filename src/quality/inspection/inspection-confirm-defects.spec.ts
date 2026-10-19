import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService, PreparedInspectionDefects } from '../defect/defect-record-write.service';
import { prepareConfirmDefects, syncConfirmDefectsWithin } from './inspection-rejection-defects';

/** omf-all-around#121 — 한 회차의 불합격 사유는 확정 시점 입력 1벌, 합격·보류 회차엔 불량 기록이 없다(장부 P-47). */
const ROW = { defectCodeId: 5, defectQty: 3, defectDescription: '찍힘' };
const PREPARED: PreparedInspectionDefects = { rows: [ROW], processId: 77n, uomId: 2 };

function defectsService() {
  return {
    prepareInspectionDefects: jest.fn().mockResolvedValue(PREPARED),
    writeInspectionDefectsWithin: jest.fn().mockResolvedValue(undefined),
  } as unknown as DefectRecordWriteService & {
    prepareInspectionDefects: jest.Mock;
    writeInspectionDefectsWithin: jest.Mock;
  };
}

function prisma(type: string, judgment: string | null) {
  return {
    inspection_result: {
      findUnique: jest.fn().mockResolvedValue({
        uom_id: 2n,
        overall_judgment_code: judgment,
        inspection_request: { inspection_type_code: type },
      }),
    },
  } as unknown as PrismaService;
}

function tx(type: string, recordIds: bigint[], repairs = 0) {
  return {
    inspection_request: {
      findUnique: jest.fn().mockResolvedValue({ inspection_type_code: type, lot_id: 30n, work_order_id: null }),
    },
    defect_record: {
      findMany: jest.fn().mockResolvedValue(recordIds.map((id) => ({ defect_record_id: id }))),
      deleteMany: jest.fn().mockResolvedValue({ count: recordIds.length }),
    },
    repair_result: { count: jest.fn().mockResolvedValue(repairs) },
    repair_execution: { count: jest.fn().mockResolvedValue(0) },
  };
}

async function errorOf(promise: Promise<unknown>): Promise<ContractException> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ContractException);
  return error as ContractException;
}

describe('prepareConfirmDefects', () => {
  it('사유를 싣지 않으면 null — 이미 붙은 기록을 쓴다', async () => {
    const service = defectsService();
    await expect(prepareConfirmDefects(prisma('IQC', 'REJECTED'), service, 8n, {})).resolves.toBeNull();
    expect(service.prepareInspectionDefects).not.toHaveBeenCalled();
  });

  it('IQC 불합격이면 결과의 단위로 검증한다', async () => {
    const service = defectsService();
    await expect(prepareConfirmDefects(prisma('IQC', null), service, 8n, { overallJudgmentCode: 'REJECTED', defects: [ROW] })).resolves.toBe(PREPARED);
    expect(service.prepareInspectionDefects).toHaveBeenCalledWith([ROW], 2);
  });

  it('IQC 불합격에 빈 배열이면 400 defects REQUIRED', async () => {
    const error = await errorOf(prepareConfirmDefects(prisma('IQC', 'REJECTED'), defectsService(), 8n, { defects: [] }));
    expect(error.errors[0]).toMatchObject({ field: 'defects', code: 'REQUIRED' });
  });

  it('합격 확정에 사유를 실으면 400 defects INVALID', async () => {
    const error = await errorOf(
      prepareConfirmDefects(prisma('IQC', 'REJECTED'), defectsService(), 8n, { overallJudgmentCode: 'ACCEPTED', defects: [ROW] }),
    );
    expect(error.errors[0]).toMatchObject({ field: 'defects', code: 'INVALID' });
  });

  it('IQC 가 아닌 결과에 사유를 실으면 400 defects INVALID', async () => {
    const error = await errorOf(prepareConfirmDefects(prisma('PQC', 'REJECTED'), defectsService(), 8n, { defects: [ROW] }));
    expect(error.errors[0]).toMatchObject({ field: 'defects', code: 'INVALID' });
  });
});

describe('syncConfirmDefectsWithin', () => {
  const base = { inspectionResultId: 8n, inspectionRequestId: 9n, detectedAt: new Date('2026-10-19T00:00:00Z'), actor: { appUserId: 1, workerId: 4n } };

  it('불합격 + 사유면 기존 기록을 지우고 본문 값으로 다시 쓴다', async () => {
    const t = tx('IQC', [11n, 12n]);
    const service = defectsService();
    await syncConfirmDefectsWithin(t as unknown as Prisma.TransactionClient, service, { ...base, judgment: 'REJECTED', prepared: PREPARED });

    expect(t.defect_record.deleteMany).toHaveBeenCalledWith({ where: { defect_record_id: { in: [11n, 12n] } } });
    expect(service.writeInspectionDefectsWithin).toHaveBeenCalledWith(
      t,
      PREPARED,
      { inspectionResultId: 8n, lotId: 30n, workOrderId: null, detectedAt: base.detectedAt },
      base.actor,
    );
  });

  it.each(['ACCEPTED', 'HELD'])('%s 확정은 그 회차의 IQC 불량 기록을 지운다', async (judgment) => {
    const t = tx('IQC', [11n]);
    const service = defectsService();
    await syncConfirmDefectsWithin(t as unknown as Prisma.TransactionClient, service, { ...base, judgment, prepared: null });

    expect(t.defect_record.findMany).toHaveBeenCalledWith({
      where: { inspection_result_id: 8n, source_type_code: 'IQC' },
      select: { defect_record_id: true },
    });
    expect(t.defect_record.deleteMany).toHaveBeenCalled();
    expect(service.writeInspectionDefectsWithin).not.toHaveBeenCalled();
  });

  it('불합격인데 사유를 싣지 않으면 손대지 않는다', async () => {
    const t = tx('IQC', [11n]);
    await syncConfirmDefectsWithin(t as unknown as Prisma.TransactionClient, defectsService(), { ...base, judgment: 'REJECTED', prepared: null });
    expect(t.inspection_request.findUnique).not.toHaveBeenCalled();
    expect(t.defect_record.deleteMany).not.toHaveBeenCalled();
  });

  it('IQC 가 아니면 손대지 않는다', async () => {
    const t = tx('PQC', [11n]);
    await syncConfirmDefectsWithin(t as unknown as Prisma.TransactionClient, defectsService(), { ...base, judgment: 'ACCEPTED', prepared: null });
    expect(t.defect_record.findMany).not.toHaveBeenCalled();
  });

  it('잠근 뒤 판정이 불합격이 아니면 사유를 남기지 않고 400 INVALID', async () => {
    const t = tx('IQC', []);
    const error = await errorOf(
      syncConfirmDefectsWithin(t as unknown as Prisma.TransactionClient, defectsService(), { ...base, judgment: 'ACCEPTED', prepared: PREPARED }),
    );
    expect(error.errors[0]).toMatchObject({ field: 'defects', code: 'INVALID' });
  });

  it('수리 이력이 붙은 기록은 지우지 않고 400 STATE_LOCKED', async () => {
    const t = tx('IQC', [11n], 1);
    const error = await errorOf(
      syncConfirmDefectsWithin(t as unknown as Prisma.TransactionClient, defectsService(), { ...base, judgment: 'ACCEPTED', prepared: null }),
    );
    expect(error.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    expect(t.defect_record.deleteMany).not.toHaveBeenCalled();
  });
});
