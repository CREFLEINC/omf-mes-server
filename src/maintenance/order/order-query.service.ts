import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import {
  PagedResponse,
  pageRequest,
  pagedResponse,
} from "../../common/pagination";
import { PrismaService } from "../../prisma/prisma.service";
import {
  MaintenanceOrderView,
  ORDER_INCLUDE,
  maintenanceOrderView,
} from "./order-view";

export interface MaintenanceOrderQuery {
  targetTypeCode?: "EQUIPMENT" | "MOLD";
  targetId?: number;
  statusCode?: string;
  maintenanceTypeCode?: "CORRECTIVE" | "PREVENTIVE";
  plannedFrom?: string;
  plannedTo?: string;
  page?: number;
  size?: number;
}

export type MaintenanceOrderList = PagedResponse<MaintenanceOrderView> & {
  totalCount: number;
};

@Injectable()
export class MaintenanceOrderQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: MaintenanceOrderQuery): Promise<MaintenanceOrderList> {
    const page = pageRequest(query);
    if (query.targetId !== undefined && !Number.isSafeInteger(query.targetId))
      throw rangeError("targetId", "대상 식별자 범위가 너무 큽니다.");
    if (
      query.plannedFrom &&
      query.plannedTo &&
      query.plannedFrom > query.plannedTo
    )
      throw rangeError(
        "plannedTo",
        "계획 종료일은 시작일보다 빠를 수 없습니다.",
      );

    const where: Prisma.maintenance_orderWhereInput = {
      ...(query.statusCode === undefined
        ? {}
        : { status_code: query.statusCode }),
      ...(query.maintenanceTypeCode === undefined
        ? {}
        : { order_type_code: query.maintenanceTypeCode }),
      ...plannedWhere(query),
      ...targetWhere(query),
    };

    return this.prisma.$transaction(
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.maintenance_order.findMany({
            where,
            include: ORDER_INCLUDE,
            orderBy: [
              { planned_date: "desc" },
              { maintenance_order_id: "desc" },
            ],
            skip: page.skip,
            take: page.take,
          }),
          tx.maintenance_order.count({ where }),
        ]);
        if (!Number.isSafeInteger(total))
          throw new Error("Maintenance order count exceeds safe integer range");
        return {
          ...pagedResponse(rows.map(maintenanceOrderView), total, page),
          totalCount: total,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(
    maintenanceOrderId: number,
  ): Promise<{ view: MaintenanceOrderView; versionNo: number }> {
    if (!Number.isSafeInteger(maintenanceOrderId))
      throw rangeError("maintenanceOrderId", "지시 식별자 범위가 너무 큽니다.");
    const row = await this.prisma.maintenance_order.findUnique({
      where: { maintenance_order_id: maintenanceOrderId },
      include: ORDER_INCLUDE,
    });
    if (!row) throw new NotFoundException("없는 보전 지시입니다.");
    return { view: maintenanceOrderView(row), versionNo: row.version_no };
  }
}

function targetWhere(
  query: MaintenanceOrderQuery,
): Prisma.maintenance_orderWhereInput {
  if (query.targetTypeCode !== undefined)
    return {
      target_type_code: query.targetTypeCode,
      ...(query.targetId === undefined
        ? {}
        : query.targetTypeCode === "EQUIPMENT"
          ? { equipment_id: query.targetId }
          : { mold_id: query.targetId }),
    };
  if (query.targetId !== undefined)
    return {
      OR: [{ equipment_id: query.targetId }, { mold_id: query.targetId }],
    };
  return {};
}

function plannedWhere(
  query: MaintenanceOrderQuery,
): Prisma.maintenance_orderWhereInput {
  if (query.plannedFrom === undefined && query.plannedTo === undefined)
    return {};
  const planned_date: Prisma.DateTimeNullableFilter = {};
  if (query.plannedFrom !== undefined)
    planned_date.gte = new Date(`${query.plannedFrom}T00:00:00Z`);
  if (query.plannedTo !== undefined)
    planned_date.lte = new Date(`${query.plannedTo}T00:00:00Z`);
  return { planned_date };
}

function rangeError(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field(name, ERROR_CODE.RANGE, message),
  ]);
}
