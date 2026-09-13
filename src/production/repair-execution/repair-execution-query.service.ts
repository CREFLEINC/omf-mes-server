import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { RepairExecutionView, repairExecutionView } from './repair-execution-view';

/**
 * 계약 질의 6 전건 + 페이지 2 — 필수는 하나도 없다(I-25 §1-2). `page`·`size` 의
 * `minimum`·`maximum` 은 계약이 선언해 `ContractValidationGuard` 가 이미 막는다(§1-2).
 */
export interface RepairExecutionListQuery {
  open?: boolean;
  defectRecordId?: unknown;
  lotId?: unknown;
  startedFrom?: string;
  startedTo?: string;
  page?: number;
  size?: number;
}

/**
 * ⭐ 정렬 축 — 계약 침묵. 시각 desc + PK desc(구간형 open 목록의 저장소 선례
 * `lot-hold-query.service.ts`·`work-session-query.service.ts` 를 따른다 · I-25 §0 자리 3 ⓑ · R-8).
 * ⚠ 대가: 계약이 이 목록을 「투입 대기 목록」이라 부르는데 첫 줄이 «가장 최근» 건이다(통보 160).
 */
export const REPAIR_EXECUTION_ORDER_BY: Prisma.repair_executionOrderByWithRelationInput[] = [
  { started_at: 'desc' },
  { repair_execution_id: 'desc' },
];

/**
 * 수리 실행 목록 조회 1건(I-25 PR ①). ⛔ 상세 GET 이 계약에 없다 — 만들지 않는다.
 * ⛔ `defect_record` 를 읽기만 한다 — 다른 도메인의 service 를 부르지 않는다(아키텍처 §1).
 */
@Injectable()
export class RepairExecutionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: RepairExecutionListQuery, terminalPlantId?: bigint): Promise<PagedResponse<RepairExecutionView>> {
    const page = pageRequest(query);
    // ⭐ 여집합 — `open ?? true` → `returned_at: null` · `false` → `{ not: null }`
    //   (`work-session-query.service.ts:56` 사본 · I-25 §0 자리 3 ⓐ).
    const open = query.open ?? true;
    const lotId = numeric('lotId', query.lotId);
    const startedAt = {
      ...(query.startedFrom === undefined ? {} : { gte: new Date(query.startedFrom) }),
      ...(query.startedTo === undefined ? {} : { lt: new Date(query.startedTo) }),
    };
    const where: Prisma.repair_executionWhereInput = {
      returned_at: open ? null : { not: null },
      ...(terminalPlantId === undefined ? {} : { OR: [
        { defect_record: { lot: { plant_id: terminalPlantId }, OR: [
          { work_order_id: null },
          { work_order: { production_line: { plant_id: terminalPlantId } } },
        ] } },
        { defect_record: { lot_id: null, work_order: { production_line: { plant_id: terminalPlantId } } } },
      ] }),
      ...filter('defect_record_id', numeric('defectRecordId', query.defectRecordId)),
      // ⭐ `lotId` 는 이 표의 칸이 아니다 — 원 불량이 매인 LOT 으로 1홉 중첩 필터한다(§3-3).
      //   `defect_record.lot_id` 는 nullable 이라 LOT 이 없는 불량은 여기 걸리지 않는다.
      ...(lotId === undefined ? {} : { defect_record: { lot_id: BigInt(lotId) } }),
      ...(Object.keys(startedAt).length === 0 ? {} : { started_at: startedAt }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.repair_execution.findMany({
        where,
        orderBy: REPAIR_EXECUTION_ORDER_BY,
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.repair_execution.count({ where }),
    ]);
    return pagedResponse(rows.map(repairExecutionView), total, page);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(`material-return-query.service.ts` 사본). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
