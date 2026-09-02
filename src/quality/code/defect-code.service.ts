import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import {
  Editability,
  ReferenceQuery,
  Referrer,
  assertNotBlank,
  countReferences,
  filter,
  optional,
  referencePage,
  referenceWhere,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertTwoLevel } from './two-level';

/** `quality.defect_code` 를 FK 로 가리키는 자리 전부. 실측이고 e2e 가 대조한다. */
export const DEFECT_CODE_REFERRERS: readonly Referrer[] = [
  ['quality.defect_code', 'parent_defect_code_id'],
  ['quality.defect_code_process', 'defect_code_id'],
  ['quality.defect_record', 'defect_code_id'],
];

/** 계약 `CauseCode` 와 동형. */
interface DefectCodeView {
  defectCodeId: number;
  defectCode: string;
  defectName: string;
  nameKo: string | null;
  nameVi: string | null;
  parentDefectCodeId: number | null;
  processId: number | null;
  /**
   * 처분구분(재작업가능/폐기). 계약이 `enum` 으로 못박아 가드가 어휘를 거른다.
   * ⛔ 없으면 «필드를 안 싣는다» — `DefectCode` 쪽 타입이 nullable 이 아니다(요청 스키마는
   * `null` 을 받는데 응답 스키마는 안 받는다 — 비대칭이라 걸리기 쉽다).
   */
  dispositionTypeCode?: string;
  isActive: boolean;
}

export interface DefectCodeWrite {
  defectCode: string;
  defectName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  parentDefectCodeId?: number | null;
  processId?: number | null;
  dispositionTypeCode?: string | null;
}

export interface DefectCodeQuery extends ReferenceQuery {
  parentDefectCodeId?: number;
}

type DefectCodeRow = Prisma.defect_codeGetPayload<object>;

export interface DefectCodeResult {
  defectCode: DefectCodeView;
  editability: Editability;
  versionNo: number;
}

/** 불량코드. 화면은 `W-06-03`(불량·불량코드 2계층 마스터)가 소유한다. */
@Injectable()
export class DefectCodeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: DefectCodeQuery): Promise<PagedResponse<DefectCodeView>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'defect_code', name: 'defect_name' },
      filter('parent_defect_code_id', query.parentDefectCodeId),
    );
    const [rows, total] = await Promise.all([
      this.prisma.defect_code.findMany({
        where,
        orderBy: { defect_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.defect_code.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(defectCodeId: number): Promise<DefectCodeResult> {
    const row = await this.prisma.defect_code.findUnique({ where: { defect_code_id: defectCodeId } });
    if (!row) throw new NotFoundException('없는 불량코드입니다.');

    const referenceCount = await countReferences(this.prisma, DEFECT_CODE_REFERRERS, row.defect_code_id);
    return {
      defectCode: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(input: DefectCodeWrite): Promise<DefectCodeView> {
    assertNotBlank([
      ['defectCode', input.defectCode],
      ['defectName', input.defectName],
    ]);
    await this.assertCodeFree(input.defectCode, null);
    await this.assertProcess(input.processId);
    await this.assertParent(null, input.parentDefectCodeId);

    return view(
      await this.prisma.defect_code.create({
        data: {
          defect_code: input.defectCode,
          defect_name: input.defectName,
          ...optional('name_ko', input.nameKo),
          ...optional('name_vi', input.nameVi),
          ...optional('parent_defect_code_id', input.parentDefectCodeId),
          ...optional('process_id', input.processId),
          ...optional('disposition_type_code', input.dispositionTypeCode),
        },
      }),
    );
  }

  async update(
    defectCodeId: number,
    version: number,
    input: DefectCodeWrite,
  ): Promise<DefectCodeResult> {
    assertNotBlank([
      ['defectCode', input.defectCode],
      ['defectName', input.defectName],
    ]);
    await this.assertCodeFree(input.defectCode, defectCodeId);
    await this.assertProcess(input.processId);
    await this.assertParent(defectCodeId, input.parentDefectCodeId);

    const updated = await this.prisma.defect_code.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { defect_code_id: defectCodeId, version_no: version },
      data: {
        defect_code: input.defectCode,
        defect_name: input.defectName,
        ...optional('name_ko', input.nameKo),
        ...optional('name_vi', input.nameVi),
        ...optional('parent_defect_code_id', input.parentDefectCodeId),
        ...optional('process_id', input.processId),
        ...optional('disposition_type_code', input.dispositionTypeCode),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(defectCodeId, updated.count);
    return this.get(defectCodeId);
  }

  async setActive(
    defectCodeId: number,
    version: number,
    isActive: boolean,
  ): Promise<DefectCodeResult> {
    const updated = await this.prisma.defect_code.updateMany({
      where: { defect_code_id: defectCodeId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(defectCodeId, updated.count);
    return this.get(defectCodeId);
  }

  /** 2계층 판정에 필요한 셋을 한 번에 읽는다. */
  private async assertParent(
    defectCodeId: number | null,
    parentId: number | null | undefined,
  ): Promise<void> {
    if (parentId == null) return;
    const parent = await this.prisma.defect_code.findUnique({
      where: { defect_code_id: parentId },
      select: { defect_code_id: true, parent_defect_code_id: true },
    });
    if (!parent) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'parentDefectCodeId',
          code: ERROR_CODE.INVALID,
          message: '없는 불량코드입니다.',
        },
      ]);
    }

    const children =
      defectCodeId === null
        ? 0
        : await this.prisma.defect_code.count({ where: { parent_defect_code_id: defectCodeId } });
    assertTwoLevel(
      'parentDefectCodeId',
      defectCodeId === null ? null : { id: defectCodeId, parentId: null, hasChildren: children > 0 },
      {
        id: Number(parent.defect_code_id),
        parentId:
          parent.parent_defect_code_id === null ? null : Number(parent.parent_defect_code_id),
        hasChildren: false,
      },
    );
  }

  private async assertProcess(processId: number | null | undefined): Promise<void> {
    if (processId == null) return;
    const process = await this.prisma.process.findUnique({
      where: { process_id: processId },
      select: { process_id: true },
    });
    if (process) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field: 'processId', code: ERROR_CODE.INVALID, message: '없는 공정입니다.' },
    ]);
  }

  private async assertCodeFree(defectCode: string, self: number | null): Promise<void> {
    const taken = await this.prisma.defect_code.findUnique({
      where: { defect_code: defectCode },
      select: { defect_code_id: true },
    });
    if (!taken || (self !== null && Number(taken.defect_code_id) === self)) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'defectCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['defectCode'],
        message: '이미 있는 불량코드입니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(defectCodeId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.defect_code.findUnique({
      where: { defect_code_id: defectCodeId },
      select: { defect_code_id: true },
    });
    if (!exists) throw new NotFoundException('없는 불량코드입니다.');
    assertUpdated(0);
  }
}

function view(row: DefectCodeRow): DefectCodeView {
  return {
    defectCodeId: Number(row.defect_code_id),
    defectCode: row.defect_code,
    defectName: row.defect_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    parentDefectCodeId:
      row.parent_defect_code_id === null ? null : Number(row.parent_defect_code_id),
    processId: row.process_id === null ? null : Number(row.process_id),
    ...(row.disposition_type_code === null
      ? {}
      : { dispositionTypeCode: row.disposition_type_code }),
    isActive: row.is_active,
  };
}
