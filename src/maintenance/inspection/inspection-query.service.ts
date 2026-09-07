import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import {
  PagedResponse,
  pageRequest,
  pagedResponse,
} from "../../common/pagination";
import { PrismaService } from "../../prisma/prisma.service";
import { maintenanceDateRange } from "../maintenance-calendar";
import {
  INSPECTION_INCLUDE,
  InspectionView,
  inspectionView,
} from "./inspection-view";

export interface InspectionQuery {
  equipmentId?: number;
  inspectionTypeCode?: string;
  inspectedFrom?: string;
  inspectedTo?: string;
  overallResultCode?: "PASS" | "FAIL";
  withoutMaintenanceOrder?: boolean;
  sort?: "inspectedAtDesc" | "inspectedAtAsc";
  page?: number;
  size?: number;
}

export type InspectionList = PagedResponse<InspectionView> & {
  totalCount: number;
};
type InspectionId = { equipment_inspection_id: bigint };
type InspectionPlant = {
  plant_id: bigint;
  timezone_code: string;
  has_missing_time: boolean;
};

const INSPECTION_FROM = Prisma.sql`
  FROM maintenance.equipment_inspection i
  JOIN mdm.equipment e ON e.equipment_id = i.equipment_id
  JOIN mdm.plant p ON p.plant_id = e.plant_id`;

@Injectable()
export class InspectionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InspectionQuery): Promise<InspectionList> {
    const page = pageRequest(query);
    if (query.withoutMaintenanceOrder !== true) {
      // 설계 미정 — 문의 094: 설비·유형·size=1도 전 이력의 기간을 대신하지 않는다.
      const missing = (["inspectedFrom", "inspectedTo"] as const)
        .filter((name) => query[name] === undefined)
        .map((name) =>
          field(name, ERROR_CODE.REQUIRED, "점검 조회 기간이 필요합니다."),
        );
      if (missing.length)
        throw new ContractException(HttpStatus.BAD_REQUEST, missing);
    }
    if (
      query.inspectedFrom &&
      query.inspectedTo &&
      query.inspectedFrom > query.inspectedTo
    ) {
      return { ...pagedResponse<InspectionView>([], 0, page), totalCount: 0 };
    }

    // 공장 설정·count·페이지·라인이 같은 스냅샷을 읽는다. 업무 id는 한 페이지뿐이다.
    return this.prisma.$transaction(
      async (tx) => {
        const conditions = [Prisma.sql`TRUE`];
        if (query.equipmentId !== undefined)
          conditions.push(Prisma.sql`i.equipment_id = ${query.equipmentId}`);
        if (query.inspectionTypeCode !== undefined)
          conditions.push(
            Prisma.sql`i.inspection_type_code = ${query.inspectionTypeCode}`,
          );
        if (query.overallResultCode !== undefined)
          conditions.push(
            Prisma.sql`i.judgment_code = ${query.overallResultCode}`,
          );
        if (query.withoutMaintenanceOrder === true) {
          conditions.push(Prisma.sql`NOT EXISTS (
          SELECT 1 FROM maintenance.maintenance_order_trigger t
          WHERE t.trigger_type_code = 'INSPECTION_NG'
            AND t.source_id = i.equipment_inspection_id
        )`);
        }

        if (
          query.inspectedFrom !== undefined ||
          query.inspectedTo !== undefined
        ) {
          // 같은 실제 관계 필터로 좁혀 무관한 공장의 시간대는 평가하지 않는다.
          const plants = await tx.$queryRaw<InspectionPlant[]>(Prisma.sql`
          SELECT p.plant_id, p.timezone_code, bool_or(i.inspected_at IS NULL) AS has_missing_time
          ${INSPECTION_FROM} WHERE ${Prisma.join(conditions, " AND ")}
          GROUP BY p.plant_id, p.timezone_code`);
          const ranges = plants.map((plant) => {
            // 설계 미정 — 문의 091: 기간 소속을 알 수 없는 행을 날짜 WHERE로 숨기지 않는다.
            if (plant.has_missing_time)
              throw new Error("Missing required inspection time");
            const range = maintenanceDateRange(
              query.inspectedFrom,
              query.inspectedTo,
              plant.timezone_code,
            );
            const bounds = [Prisma.sql`p.plant_id = ${plant.plant_id}`];
            if (range.gte)
              bounds.push(Prisma.sql`i.inspected_at >= ${range.gte}`);
            if (range.lt) bounds.push(Prisma.sql`i.inspected_at < ${range.lt}`);
            return Prisma.sql`(${Prisma.join(bounds, " AND ")})`;
          });
          conditions.push(
            ranges.length
              ? Prisma.sql`(${Prisma.join(ranges, " OR ")})`
              : Prisma.sql`FALSE`,
          );
        }

        const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
        const direction =
          query.sort === "inspectedAtAsc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
        const [ids, counts] = await Promise.all([
          tx.$queryRaw<InspectionId[]>(Prisma.sql`
          SELECT i.equipment_inspection_id ${INSPECTION_FROM} ${where}
          ORDER BY i.inspected_at ${direction} NULLS LAST, i.equipment_inspection_id ${direction}
          LIMIT ${page.take} OFFSET ${page.skip}`),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
          SELECT count(*) AS total ${INSPECTION_FROM} ${where}`),
        ]);
        const rows = await tx.equipment_inspection.findMany({
          where: {
            equipment_inspection_id: {
              in: ids.map((id) => id.equipment_inspection_id),
            },
          },
          include: INSPECTION_INCLUDE,
        });
        const byId = new Map(
          rows.map((row) => [row.equipment_inspection_id, row]),
        );
        const items = ids.map(({ equipment_inspection_id: id }) => {
          const row = byId.get(id);
          if (!row)
            throw new Error("Inspection disappeared from read snapshot");
          return inspectionView(row);
        });
        const total = Number(counts[0].total);
        return { ...pagedResponse(items, total, page), totalCount: total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(inspectionId: number): Promise<InspectionView> {
    const row = await this.prisma.equipment_inspection.findUnique({
      where: { equipment_inspection_id: inspectionId },
      include: INSPECTION_INCLUDE,
    });
    if (!row) throw new NotFoundException("없는 점검 기록입니다.");
    return inspectionView(row);
  }
}
