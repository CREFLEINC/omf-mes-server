import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import {
  Editability,
  ReferenceQuery,
  Referrer,
  assertCodeValues,
  countReferences,
  referencePage,
  referenceWhere,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 공정 마스터는 **MES 정본**이다 — ERP 에서 오지 않는다(REQ-PR-0026). 관리 화면은
 * `W-06-01` 《공정 마스터》 탭(6d03a44 · 사용자 확정 2026-09-03).
 *
 * 참조처는 전부 `process_id` FK 라 «셀 수 있다» — code_value 처럼 NOT_COUNTABLE 로
 * 잠그는 갈래가 아니다(계약 `GET /mdm/processes/{processId}`).
 */
export const PROCESS_REFERRERS: readonly Referrer[] = [
  ['app.operation_policy', 'process_id'],
  ['logistics.subcontract_order', 'process_id'],
  ['maintenance.collection_channel', 'process_id'],
  ['mdm.equipment', 'process_id'],
  ['mdm.terminal_process', 'process_id'],
  ['mdm.worker_qualification', 'process_id'],
  ['planning.bom_component', 'actual_use_process_id'],
  ['planning.routing_operation', 'process_id'],
  ['production.material_consumption', 'actual_use_process_id'],
  ['production.repair_execution', 'repair_process_id'],
  ['quality.cause_code', 'process_id'],
  ['quality.concession', 'allowed_process_id'],
  ['quality.defect_code', 'process_id'],
  ['quality.defect_code_process', 'process_id'],
  ['quality.defect_record', 'detection_process_id'],
  ['quality.defect_record', 'occurrence_process_id'],
  ['quality.inspection_plan', 'process_id'],
];

/** 계약 `Process` 와 동형. */
interface ProcessView {
  processId: number;
  processCode: string;
  processName: string;
  processTypeCode: string;
  isActive: boolean;
}

/** 계약 `ProcessCreate`·`ProcessUpdate` — 같은 세 칸. `isActive` 는 받지 않는다. */
export interface ProcessWrite {
  processCode: string;
  processName: string;
  processTypeCode: string;
}

type ProcessRow = Prisma.processGetPayload<object>;

export type ProcessResult = {
  process: ProcessView;
  editability: Editability;
  versionNo: number;
};

@Injectable()
export class ProcessService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ReferenceQuery): Promise<PagedResponse<ProcessView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'process_code', name: 'process_name' });
    const [rows, total] = await Promise.all([
      this.prisma.process.findMany({
        where,
        orderBy: { process_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.process.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(processId: number): Promise<ProcessResult> {
    const row = await this.prisma.process.findUnique({ where: { process_id: processId } });
    if (!row) throw new NotFoundException('없는 공정입니다.');

    const referenceCount = await countReferences(this.prisma, PROCESS_REFERRERS, row.process_id);
    return {
      process: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(input: ProcessWrite): Promise<ProcessView> {
    await this.assertProcessType(input.processTypeCode);
    await this.assertCodeFree(input.processCode, null);
    return view(
      await this.prisma.process.create({
        data: {
          process_code: input.processCode,
          process_name: input.processName,
          process_type_code: input.processTypeCode,
        },
      }),
    );
  }

  async update(processId: number, version: number, input: ProcessWrite): Promise<ProcessResult> {
    await this.assertProcessType(input.processTypeCode);
    const current = await this.get(processId);

    if (input.processCode !== current.process.processCode) {
      // 공유계약 B-4 — 참조가 있으면 코드를 못 바꾼다. 「업무 규칙 위반은 409 가 아니라 400」(계약).
      if (!current.editability.codeEditable) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'field',
            field: 'processCode',
            code: ERROR_CODE.STATE_LOCKED,
            message: `이 공정을 가리키는 행이 ${current.editability.referenceCount}건 있어 코드를 바꿀 수 없습니다.`,
          },
        ]);
      }
      await this.assertCodeFree(input.processCode, processId);
    }

    const updated = await this.prisma.process.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { process_id: processId, version_no: version },
      data: {
        process_code: input.processCode,
        process_name: input.processName,
        process_type_code: input.processTypeCode,
        version_no: { increment: 1 },
      },
    });
    assertUpdated(updated.count);
    return this.get(processId);
  }

  /** 중지는 «앞으로 새 라인에서 고를 수 없다»는 뜻이다 — 이미 확정된 Routing 은 영향받지 않는다(계약). */
  async setActive(processId: number, version: number, isActive: boolean): Promise<ProcessResult> {
    const updated = await this.prisma.process.updateMany({
      where: { process_id: processId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(processId, updated.count);
    return this.get(processId);
  }

  private assertProcessType(processTypeCode: string): Promise<void> {
    return assertCodeValues(this.prisma, [
      { field: 'processTypeCode', value: processTypeCode, groupCode: 'PROCESS_TYPE' },
    ]);
  }

  /** `process_code` 는 전역 유일 — 「중복이면 400」(계약). */
  private async assertCodeFree(processCode: string, self: number | null): Promise<void> {
    const taken = await this.prisma.process.findUnique({
      where: { process_code: processCode },
      select: { process_id: true },
    });
    if (!taken || (self !== null && Number(taken.process_id) === self)) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'processCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['processCode'],
        message: '이미 있는 공정 코드입니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(processId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.process.findUnique({
      where: { process_id: processId },
      select: { process_id: true },
    });
    if (!exists) throw new NotFoundException('없는 공정입니다.');
    assertUpdated(0);
  }
}

function view(row: ProcessRow): ProcessView {
  return {
    processId: Number(row.process_id),
    processCode: row.process_code,
    processName: row.process_name,
    processTypeCode: row.process_type_code,
    isActive: row.is_active,
  };
}
