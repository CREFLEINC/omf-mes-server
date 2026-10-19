import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordView, defectRecordView } from './defect-view';

/** 계약 `DefectRecordCreate`(장부 P-42). 두 공정은 IQC 원천일 때만 생략할 수 있다. */
export interface DefectRecordCreate {
  sourceCode: string;
  defectCodeId: number;
  defectQty: number;
  uomId: number;
  detectedAt: string;
  occurrenceProcessId?: number | null;
  detectionProcessId?: number | null;
  inspectionResultId?: number | null;
  productionResultId?: number | null;
  workOrderId?: number | null;
  lotId?: number | null;
  suspectedCauseCodeId?: number | null;
  defectDescription?: string | null;
  equipmentId?: number | null;
  moldId?: number | null;
  occurredAt?: string | null;
}

/** 검사 결과 본문에 함께 실리는 불합격 사유 한 줄(장부 P-42 · 오프라인 확정 경로). */
export interface InspectionDefectInput {
  defectCodeId: number;
  defectQty: number;
  defectDescription?: string | null;
  suspectedCauseCodeId?: number | null;
}

/** 트랜잭션 «밖»에서 검증을 마친 사유 — 안에서는 쓰기만 한다. */
export interface PreparedInspectionDefects {
  rows: InspectionDefectInput[];
  processId: bigint;
  uomId: number;
}

const IQC_SOURCE = 'IQC';
/** 시드 `seedSystemProcesses` 의 수입검사 공정 — 같은 값이다. */
const IQC_PROCESS_CODE = 'IQC';

/**
 * 불량 기록 등록(omf-all-around#106 · 장부 P-42). 계약이 등록 경로를 두지 않았던 자리다
 * (「03 화면 7장에 불량코드 입력이 0건」) — IQC 불합격 사유가 첫 사용처이고, PQC 자재 불량(#108)이
 * 같은 경로를 쓴다.
 *
 * ⭐ 검사 결과를 주면 LOT·W/O 는 **그 검사의 의뢰가 정한다** — 요청이 다른 값을 실으면 400 이다.
 *    한 불량이 두 LOT 에 붙어 있으면 이력(S32)이 거짓말을 한다.
 * ⭐ IQC 원천은 두 공정을 생략할 수 있다 — 기준정보의 수입검사 공정(`IQC`)이 발생·검출 공정이다
 *    (2026-10-16 결정 ④ · 칸이 NOT NULL).
 * ⚠ 귀속 작업자(`worker_id`)는 계정에 연결된 작업자다(P-38). 없으면 비운다 — 주체는 `created_by` 가 남는다.
 */
@Injectable()
export class DefectRecordWriteService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: DefectRecordCreate, appUserId: number): Promise<DefectRecordView> {
    await assertCodeValues(this.prisma, [
      { field: 'sourceCode', value: input.sourceCode, groupCode: 'DEFECT_RECORD_SOURCE' },
    ]);
    const errors: ErrorItem[] = [];
    if (!(input.defectQty > 0)) errors.push(field('defectQty', ERROR_CODE.RANGE, '불량 수량은 0 보다 커야 합니다.'));
    if (Number.isNaN(Date.parse(input.detectedAt))) errors.push(field('detectedAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
    if (input.occurredAt != null && Number.isNaN(Date.parse(input.occurredAt))) {
      errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const target = await this.resolveTarget(input);
    const processes = await this.resolveProcesses(input);
    await this.assertReferences(input);
    const worker = await this.prisma.worker.findFirst({
      where: { app_user_id: BigInt(appUserId) },
      orderBy: { worker_id: 'asc' },
      select: { worker_id: true },
    });

    const row = await this.prisma.defect_record.create({
      data: {
        source_type_code: input.sourceCode,
        defect_code_id: BigInt(input.defectCodeId),
        defect_qty: new Prisma.Decimal(input.defectQty),
        uom_id: BigInt(input.uomId),
        detected_at: new Date(input.detectedAt),
        occurred_at: input.occurredAt == null ? null : new Date(input.occurredAt),
        occurrence_process_id: processes.occurrence,
        detection_process_id: processes.detection,
        inspection_result_id: optionalId(input.inspectionResultId),
        production_result_id: optionalId(input.productionResultId),
        work_order_id: target.workOrderId,
        lot_id: target.lotId,
        suspected_cause_code_id: optionalId(input.suspectedCauseCodeId),
        defect_description: input.defectDescription ?? null,
        equipment_id: optionalId(input.equipmentId),
        mold_id: optionalId(input.moldId),
        worker_id: worker?.worker_id ?? null,
        created_by: BigInt(appUserId),
      },
    });
    return defectRecordView(row);
  }

  /**
   * IQC 검사 결과 본문의 사유를 검증한다(오프라인 확정 `POST …/inspection-results` · omf-all-around#106).
   * ⛔ 트랜잭션 «밖»이다 — 읽기 커넥션을 업무 트랜잭션이 쥐지 않는다(채번과 같은 규율).
   */
  async prepareInspectionDefects(rows: InspectionDefectInput[], uomId: number): Promise<PreparedInspectionDefects> {
    const errors: ErrorItem[] = [];
    for (const [index, row] of rows.entries()) {
      if (!(row.defectQty > 0)) errors.push(field(`defects[${index}].defectQty`, ERROR_CODE.RANGE, '불량 수량은 0 보다 커야 합니다.'));
      const code = await this.prisma.defect_code.findUnique({
        where: { defect_code_id: BigInt(row.defectCodeId) },
        select: { is_active: true },
      });
      if (code === null || !code.is_active) {
        errors.push(field(`defects[${index}].defectCodeId`, ERROR_CODE.INVALID, '사용할 수 없는 불량 코드입니다.'));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    const { occurrence } = await this.resolveProcesses({ sourceCode: IQC_SOURCE } as DefectRecordCreate);
    return { rows, processId: occurrence, uomId };
  }

  /** 검사 결과와 «같은 트랜잭션»에서 사유를 남긴다 — 결과만 서고 사유가 빠지는 부분 확정이 없다. */
  async writeInspectionDefectsWithin(
    tx: Prisma.TransactionClient,
    prepared: PreparedInspectionDefects,
    target: { inspectionResultId: bigint; lotId: bigint | null; workOrderId: bigint | null; detectedAt: Date },
    actor: { appUserId?: number; workerId?: bigint | null },
  ): Promise<void> {
    for (const row of prepared.rows) {
      await tx.defect_record.create({
        data: {
          source_type_code: IQC_SOURCE,
          defect_code_id: BigInt(row.defectCodeId),
          defect_qty: new Prisma.Decimal(row.defectQty),
          uom_id: BigInt(prepared.uomId),
          detected_at: target.detectedAt,
          occurrence_process_id: prepared.processId,
          detection_process_id: prepared.processId,
          inspection_result_id: target.inspectionResultId,
          lot_id: target.lotId,
          work_order_id: target.workOrderId,
          suspected_cause_code_id: optionalId(row.suspectedCauseCodeId),
          defect_description: row.defectDescription ?? null,
          worker_id: actor.workerId ?? null,
          created_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
        },
      });
    }
  }

  /** 검사 결과가 있으면 그 의뢰의 LOT·W/O 를 따른다. 요청 값과 다르면 400. */
  private async resolveTarget(input: DefectRecordCreate): Promise<{ lotId: bigint | null; workOrderId: bigint | null }> {
    const requested = { lotId: optionalId(input.lotId), workOrderId: optionalId(input.workOrderId) };
    if (input.inspectionResultId == null) return requested;
    const result = await this.prisma.inspection_result.findUnique({
      where: { inspection_result_id: BigInt(input.inspectionResultId) },
      select: { inspection_request: { select: { lot_id: true, work_order_id: true } } },
    });
    if (result === null) throw one('inspectionResultId', ERROR_CODE.INVALID, '없는 검사 결과입니다.');
    const own = result.inspection_request;
    if (requested.lotId !== null && own.lot_id !== null && requested.lotId !== own.lot_id) {
      throw one('lotId', ERROR_CODE.INVALID, '이 검사 결과의 LOT 이 아닙니다.');
    }
    if (requested.workOrderId !== null && own.work_order_id !== null && requested.workOrderId !== own.work_order_id) {
      throw one('workOrderId', ERROR_CODE.INVALID, '이 검사 결과의 작업지시가 아닙니다.');
    }
    return { lotId: own.lot_id ?? requested.lotId, workOrderId: own.work_order_id ?? requested.workOrderId };
  }

  private async resolveProcesses(input: DefectRecordCreate): Promise<{ occurrence: bigint; detection: bigint }> {
    const missing = input.occurrenceProcessId == null || input.detectionProcessId == null;
    if (!missing) {
      return { occurrence: BigInt(input.occurrenceProcessId as number), detection: BigInt(input.detectionProcessId as number) };
    }
    if (input.sourceCode !== IQC_SOURCE) {
      const name = input.occurrenceProcessId == null ? 'occurrenceProcessId' : 'detectionProcessId';
      throw one(name, ERROR_CODE.REQUIRED, '발생·검출 공정이 필요합니다.');
    }
    const iqc = await this.prisma.process.findUnique({
      where: { process_code: IQC_PROCESS_CODE },
      select: { process_id: true, is_active: true },
    });
    if (iqc === null || !iqc.is_active) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '기준정보에 수입검사(IQC) 공정이 없습니다. 관리자에게 공정 등록을 요청하세요.',
        },
      ]);
    }
    return {
      occurrence: input.occurrenceProcessId == null ? iqc.process_id : BigInt(input.occurrenceProcessId),
      detection: input.detectionProcessId == null ? iqc.process_id : BigInt(input.detectionProcessId),
    };
  }

  /** ⛔ 없는 id 를 그대로 넘기면 FK 위반이 500 으로 샌다 — 먼저 본다. */
  private async assertReferences(input: DefectRecordCreate): Promise<void> {
    const errors: ErrorItem[] = [];
    const [code, uom] = await Promise.all([
      this.prisma.defect_code.findUnique({
        where: { defect_code_id: BigInt(input.defectCodeId) },
        select: { is_active: true },
      }),
      this.prisma.uom.findUnique({ where: { uom_id: BigInt(input.uomId) }, select: { uom_id: true } }),
    ]);
    if (code === null || !code.is_active) errors.push(field('defectCodeId', ERROR_CODE.INVALID, '사용할 수 없는 불량 코드입니다.'));
    if (uom === null) errors.push(field('uomId', ERROR_CODE.INVALID, '없는 단위입니다.'));
    for (const [name, id] of [
      ['occurrenceProcessId', input.occurrenceProcessId],
      ['detectionProcessId', input.detectionProcessId],
    ] as const) {
      if (id == null) continue;
      const process = await this.prisma.process.findUnique({ where: { process_id: BigInt(id) }, select: { process_id: true } });
      if (process === null) errors.push(field(name, ERROR_CODE.INVALID, '없는 공정입니다.'));
    }
    if (input.lotId != null) {
      const lot = await this.prisma.lot.findUnique({ where: { lot_id: BigInt(input.lotId) }, select: { lot_id: true } });
      if (lot === null) errors.push(field('lotId', ERROR_CODE.INVALID, '없는 LOT 입니다.'));
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

function optionalId(value: number | null | undefined): bigint | null {
  return value == null ? null : BigInt(value);
}

function field(name: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field: name, code, message };
}

function one(name: string, code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [field(name, code, message)]);
}
