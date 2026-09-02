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

/** `quality.cause_code` 를 FK 로 가리키는 자리 전부. 실측이고 e2e 가 대조한다. */
export const CAUSE_CODE_REFERRERS: readonly Referrer[] = [
  ['quality.cause_code', 'parent_cause_code_id'],
  ['quality.defect_record', 'confirmed_cause_code_id'],
  ['quality.defect_record', 'suspected_cause_code_id'],
];

/** 계약 `CauseCode` 와 동형. */
interface CauseCodeView {
  causeCodeId: number;
  causeCode: string;
  causeName: string;
  nameKo: string | null;
  nameVi: string | null;
  parentCauseCodeId: number | null;
  processId: number | null;
  isActive: boolean;
}

export interface CauseCodeWrite {
  causeCode: string;
  causeName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  parentCauseCodeId?: number | null;
  processId?: number | null;
}

export interface CauseCodeQuery extends ReferenceQuery {
  parentCauseCodeId?: number;
}

type CauseCodeRow = Prisma.cause_codeGetPayload<object>;

export interface CauseCodeResult {
  causeCode: CauseCodeView;
  editability: Editability;
  versionNo: number;
}

/** 원인코드. 화면은 `W-06-03`(불량·원인코드 2계층 마스터)가 소유한다. */
@Injectable()
export class CauseCodeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CauseCodeQuery): Promise<PagedResponse<CauseCodeView>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'cause_code', name: 'cause_name' },
      filter('parent_cause_code_id', query.parentCauseCodeId),
    );
    const [rows, total] = await Promise.all([
      this.prisma.cause_code.findMany({
        where,
        orderBy: { cause_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.cause_code.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(causeCodeId: number): Promise<CauseCodeResult> {
    const row = await this.prisma.cause_code.findUnique({ where: { cause_code_id: causeCodeId } });
    if (!row) throw new NotFoundException('없는 원인코드입니다.');

    const referenceCount = await countReferences(this.prisma, CAUSE_CODE_REFERRERS, row.cause_code_id);
    return {
      causeCode: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(input: CauseCodeWrite): Promise<CauseCodeView> {
    assertNotBlank([
      ['causeCode', input.causeCode],
      ['causeName', input.causeName],
    ]);
    await this.assertCodeFree(input.causeCode, null);
    await this.assertProcess(input.processId);
    await this.assertParent(null, input.parentCauseCodeId);

    return view(
      await this.prisma.cause_code.create({
        data: {
          cause_code: input.causeCode,
          cause_name: input.causeName,
          ...optional('name_ko', input.nameKo),
          ...optional('name_vi', input.nameVi),
          ...optional('parent_cause_code_id', input.parentCauseCodeId),
          ...optional('process_id', input.processId),
        },
      }),
    );
  }

  async update(
    causeCodeId: number,
    version: number,
    input: CauseCodeWrite,
  ): Promise<CauseCodeResult> {
    assertNotBlank([
      ['causeCode', input.causeCode],
      ['causeName', input.causeName],
    ]);
    await this.assertCodeFree(input.causeCode, causeCodeId);
    await this.assertProcess(input.processId);
    await this.assertParent(causeCodeId, input.parentCauseCodeId);

    const updated = await this.prisma.cause_code.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { cause_code_id: causeCodeId, version_no: version },
      data: {
        cause_code: input.causeCode,
        cause_name: input.causeName,
        ...optional('name_ko', input.nameKo),
        ...optional('name_vi', input.nameVi),
        ...optional('parent_cause_code_id', input.parentCauseCodeId),
        ...optional('process_id', input.processId),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(causeCodeId, updated.count);
    return this.get(causeCodeId);
  }

  async setActive(
    causeCodeId: number,
    version: number,
    isActive: boolean,
  ): Promise<CauseCodeResult> {
    const updated = await this.prisma.cause_code.updateMany({
      where: { cause_code_id: causeCodeId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(causeCodeId, updated.count);
    return this.get(causeCodeId);
  }

  /** 2계층 판정에 필요한 셋을 한 번에 읽는다. */
  private async assertParent(
    causeCodeId: number | null,
    parentId: number | null | undefined,
  ): Promise<void> {
    if (parentId == null) return;
    const parent = await this.prisma.cause_code.findUnique({
      where: { cause_code_id: parentId },
      select: { cause_code_id: true, parent_cause_code_id: true },
    });
    if (!parent) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'parentCauseCodeId',
          code: ERROR_CODE.INVALID,
          message: '없는 원인코드입니다.',
        },
      ]);
    }

    const children =
      causeCodeId === null
        ? 0
        : await this.prisma.cause_code.count({ where: { parent_cause_code_id: causeCodeId } });
    assertTwoLevel(
      'parentCauseCodeId',
      causeCodeId === null ? null : { id: causeCodeId, parentId: null, hasChildren: children > 0 },
      {
        id: Number(parent.cause_code_id),
        parentId:
          parent.parent_cause_code_id === null ? null : Number(parent.parent_cause_code_id),
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

  private async assertCodeFree(causeCode: string, self: number | null): Promise<void> {
    const taken = await this.prisma.cause_code.findUnique({
      where: { cause_code: causeCode },
      select: { cause_code_id: true },
    });
    if (!taken || (self !== null && Number(taken.cause_code_id) === self)) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'causeCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['causeCode'],
        message: '이미 있는 원인코드입니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(causeCodeId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.cause_code.findUnique({
      where: { cause_code_id: causeCodeId },
      select: { cause_code_id: true },
    });
    if (!exists) throw new NotFoundException('없는 원인코드입니다.');
    assertUpdated(0);
  }
}

function view(row: CauseCodeRow): CauseCodeView {
  return {
    causeCodeId: Number(row.cause_code_id),
    causeCode: row.cause_code,
    causeName: row.cause_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    parentCauseCodeId:
      row.parent_cause_code_id === null ? null : Number(row.parent_cause_code_id),
    processId: row.process_id === null ? null : Number(row.process_id),
    isActive: row.is_active,
  };
}
