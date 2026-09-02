import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import {
  Editability,
  ReferenceQuery,
  Referrer,
  assertCodeValues,
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
import { REVISION_STATUS } from '../../planning/revision-status';

/** `quality.inspection_plan` 을 FK 로 가리키는 자리 전부. 실측이고 e2e 가 대조한다. */
export const INSPECTION_PLAN_REFERRERS: readonly Referrer[] = [
  ['quality.inspection_plan_version', 'inspection_plan_id'],
];

/** 계약 `InspectionPlan` 과 동형. */
interface InspectionPlanView {
  inspectionPlanId: number;
  inspectionPlanCode: string;
  inspectionPlanName: string;
  nameKo: string | null;
  nameVi: string | null;
  itemId: number | null;
  processId: number | null;
  routingId: number | null;
  inspectionTypeCode: string;
  approvedBy: number | null;
  approvedAt: string | null;
  pqcSkipAllowed: boolean;
  isActive: boolean;
}

export interface InspectionPlanWrite {
  inspectionPlanCode: string;
  inspectionPlanName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  itemId?: number | null;
  processId?: number | null;
  routingId?: number | null;
  inspectionTypeCode: string;
  pqcSkipAllowed?: boolean;
}

export interface InspectionPlanQuery extends ReferenceQuery {
  inspectionTypeCode?: string;
  itemId?: number;
}

type PlanRow = Prisma.inspection_planGetPayload<object>;

export interface InspectionPlanResult {
  inspectionPlan: InspectionPlanView;
  editability: Editability;
  versionNo: number;
}

/** 검사기준 헤더. 화면은 `W-06-02`(검사기준 등록 — IQC/PQC/OQC)가 소유한다. */
@Injectable()
export class InspectionPlanService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InspectionPlanQuery): Promise<PagedResponse<InspectionPlanView>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'inspection_plan_code', name: 'inspection_plan_name' },
      {
        ...filter('item_id', query.itemId),
        ...(query.inspectionTypeCode === undefined
          ? {}
          : { inspection_type_code: query.inspectionTypeCode }),
      },
    );
    const [rows, total] = await Promise.all([
      this.prisma.inspection_plan.findMany({
        where,
        orderBy: { inspection_plan_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inspection_plan.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(inspectionPlanId: number): Promise<InspectionPlanResult> {
    const row = await this.prisma.inspection_plan.findUnique({
      where: { inspection_plan_id: inspectionPlanId },
    });
    if (!row) throw new NotFoundException('없는 검사기준입니다.');

    const referenceCount = await countReferences(
      this.prisma,
      INSPECTION_PLAN_REFERRERS,
      row.inspection_plan_id,
    );
    return {
      inspectionPlan: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(input: InspectionPlanWrite): Promise<InspectionPlanView> {
    await this.assertWritable(input, null);

    return view(
      await this.prisma.inspection_plan.create({
        data: {
          inspection_plan_code: input.inspectionPlanCode,
          inspection_plan_name: input.inspectionPlanName,
          inspection_type_code: input.inspectionTypeCode,
          ...optional('name_ko', input.nameKo),
          ...optional('name_vi', input.nameVi),
          ...optional('item_id', input.itemId),
          ...optional('process_id', input.processId),
          ...optional('routing_id', input.routingId),
          ...optional('pqc_skip_allowed', input.pqcSkipAllowed),
        },
      }),
    );
  }

  async update(
    inspectionPlanId: number,
    version: number,
    input: InspectionPlanWrite,
  ): Promise<InspectionPlanResult> {
    await this.assertWritable(input, inspectionPlanId);

    const updated = await this.prisma.inspection_plan.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { inspection_plan_id: inspectionPlanId, version_no: version },
      data: {
        inspection_plan_code: input.inspectionPlanCode,
        inspection_plan_name: input.inspectionPlanName,
        inspection_type_code: input.inspectionTypeCode,
        ...optional('name_ko', input.nameKo),
        ...optional('name_vi', input.nameVi),
        ...optional('item_id', input.itemId),
        ...optional('process_id', input.processId),
        ...optional('routing_id', input.routingId),
        ...optional('pqc_skip_allowed', input.pqcSkipAllowed),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(inspectionPlanId, updated.count);
    return this.get(inspectionPlanId);
  }

  async setActive(
    inspectionPlanId: number,
    version: number,
    isActive: boolean,
  ): Promise<InspectionPlanResult> {
    const updated = await this.prisma.inspection_plan.updateMany({
      where: { inspection_plan_id: inspectionPlanId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(inspectionPlanId, updated.count);
    return this.get(inspectionPlanId);
  }

  /**
   * 「`approvedBy`·`approvedAt` 을 서버가 **동시에** 기록한다(현재 사용자·현재 시각) —
   * 둘은 짝이어야 하며 서버가 항상 함께 채우는 방식으로 그 짝을 보장한다」(계약 · `A-9`).
   * DB 에 CHECK 가 없으므로 그 짝은 이 한 줄이 유일한 보증이다.
   *
   * 「전제: 이 기준에 **확정 버전이 1건 이상** 있어야 한다 — 없으면 400
   * (`CONFIRMED_VERSION_REQUIRED`)」. 승인 해제는 제공하지 않는다.
   */
  async approve(inspectionPlanId: number, actorId: number): Promise<InspectionPlanResult> {
    const row = await this.prisma.inspection_plan.findUnique({
      where: { inspection_plan_id: inspectionPlanId },
      select: { approved_at: true },
    });
    if (!row) throw new NotFoundException('없는 검사기준입니다.');
    if (row.approved_at !== null) {
      // ⚠ 계약에 없고 서버가 정했다. 승인 해제가 없는데 다시 승인하면 «승인자 기록이
      // 덮인다» — 누가 승인했는지가 사라지는 쓰기다. 되돌림 §V-2.
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '이미 승인된 검사기준입니다. 승인 해제는 제공하지 않습니다.',
        },
      ]);
    }

    const confirmed = await this.prisma.inspection_plan_version.count({
      where: { inspection_plan_id: inspectionPlanId, status_code: REVISION_STATUS.CONFIRMED },
    });
    if (confirmed === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.CONFIRMED_VERSION_REQUIRED,
          message: '확정된 검사기준 버전이 없습니다. 버전을 확정한 뒤 승인하세요.',
        },
      ]);
    }

    await this.prisma.inspection_plan.update({
      where: { inspection_plan_id: inspectionPlanId },
      // ⛔ 둘을 한 문장에서 함께 채운다 — 나누면 그 사이가 「승인자만 있고 시각은 없는」
      // 상태가 되고, DB 에 그것을 막는 CHECK 가 없다.
      data: { approved_by: actorId, approved_at: new Date(), version_no: { increment: 1 } },
    });
    return this.get(inspectionPlanId);
  }

  private async assertWritable(
    input: InspectionPlanWrite,
    self: number | null,
  ): Promise<void> {
    assertNotBlank([
      ['inspectionPlanCode', input.inspectionPlanCode],
      ['inspectionPlanName', input.inspectionPlanName],
    ]);
    // ⚠ 설비 점검의 `inspectionTypeCode`(DAILY·MONTHLY·MAINTENANCE)와 «같은 이름 다른 값»
    // 이라 그룹을 가른다(계약 · omf-mes#186).
    await assertCodeValues(this.prisma, [
      {
        field: 'inspectionTypeCode',
        value: input.inspectionTypeCode,
        groupCode: 'QUALITY_INSPECTION_TYPE',
      },
    ]);
    await this.assertCodeFree(input.inspectionPlanCode, self);
    await this.assertTargets(input);
  }

  /**
   * ⚠ `item_id`·`process_id`·`routing_id` 가 모두 NULL 허용이라 「적용 우선순위 규칙」이
   * 필요한데 계약이 「§8-4 미정」이라 적었다. 서버는 **실재만 본다** — 우선순위를 지어내면
   * 그것이 사실상의 업무 규칙이 된다.
   */
  private async assertTargets(input: InspectionPlanWrite): Promise<void> {
    const errors: ErrorItem[] = [];
    const checks: [string, number | null | undefined, () => Promise<unknown>][] = [
      ['itemId', input.itemId, () =>
        this.prisma.item.findUnique({ where: { item_id: input.itemId as number }, select: { item_id: true } })],
      ['processId', input.processId, () =>
        this.prisma.process.findUnique({ where: { process_id: input.processId as number }, select: { process_id: true } })],
      ['routingId', input.routingId, () =>
        this.prisma.routing.findUnique({ where: { routing_id: input.routingId as number }, select: { routing_id: true } })],
    ];
    for (const [field, value, find] of checks) {
      if (value == null) continue;
      if (await find()) continue;
      errors.push({ scope: 'field', field, code: ERROR_CODE.INVALID, message: '없는 대상입니다.' });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  private async assertCodeFree(code: string, self: number | null): Promise<void> {
    const taken = await this.prisma.inspection_plan.findUnique({
      where: { inspection_plan_code: code },
      select: { inspection_plan_id: true },
    });
    if (!taken || (self !== null && Number(taken.inspection_plan_id) === self)) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'inspectionPlanCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['inspectionPlanCode'],
        message: '이미 있는 검사기준 코드입니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(inspectionPlanId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.inspection_plan.findUnique({
      where: { inspection_plan_id: inspectionPlanId },
      select: { inspection_plan_id: true },
    });
    if (!exists) throw new NotFoundException('없는 검사기준입니다.');
    assertUpdated(0);
  }
}

function view(row: PlanRow): InspectionPlanView {
  return {
    inspectionPlanId: Number(row.inspection_plan_id),
    inspectionPlanCode: row.inspection_plan_code,
    inspectionPlanName: row.inspection_plan_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    itemId: row.item_id === null ? null : Number(row.item_id),
    processId: row.process_id === null ? null : Number(row.process_id),
    routingId: row.routing_id === null ? null : Number(row.routing_id),
    inspectionTypeCode: row.inspection_type_code,
    approvedBy: row.approved_by === null ? null : Number(row.approved_by),
    approvedAt: row.approved_at === null ? null : row.approved_at.toISOString(),
    pqcSkipAllowed: row.pqc_skip_allowed,
    isActive: row.is_active,
  };
}
