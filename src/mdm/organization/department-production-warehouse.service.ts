import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

export interface ProductionWarehouseView {
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  plantId: number;
}

export interface RemovedWarehouse {
  warehouseId: number;
  activeRequestCount: number;
}

export interface ProductionWarehouseReplaced {
  items: ProductionWarehouseView[];
  removed: RemovedWarehouse[];
}

/** 아직 출고가 끝나지 않은 요청 — 대기·배포. 닫힌 요청(W/O 취소·마감)은 더 나가지 않으므로 세지 않는다. */
const ACTIVE_REQUEST_STATUSES = ['WAITING', 'REGISTERED'];

/**
 * 부서 생산 창고(피처 003 · omf-all-around#66). 이 부서 라인의 W/O 자재는 여기 연결한 창고에서 나간다.
 *
 * ⭐ 창고 유형으로 거르지 않는다 — 불량·외부 유형도 연결할 수 있다(시안 검토 9). 부서에는 공장 축이 없어
 * 다른 공장 창고가 섞일 수 있고, 출발 창고를 고를 때 W/O 공장 창고만 후보로 본다.
 * 연결을 빼도 이미 만든 요청은 그 창고에서 그대로 나간다 — 응답은 그 요청 수를 알려 줄 뿐이다.
 */
@Injectable()
export class DepartmentProductionWarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  async list(departmentId: number): Promise<{ items: ProductionWarehouseView[] }> {
    await this.assertDepartment(departmentId);
    return { items: await this.read(departmentId) };
  }

  async replace(
    departmentId: number,
    warehouseIds: number[],
    dryRun: boolean,
    appUserId: number | undefined,
  ): Promise<ProductionWarehouseReplaced> {
    await this.assertDepartment(departmentId);
    const ids = [...new Set(warehouseIds)].map(BigInt);
    const found = await this.prisma.warehouse.findMany({
      where: { warehouse_id: { in: ids }, is_active: true },
      select: { warehouse_id: true, warehouse_code: true, warehouse_name: true, plant_id: true },
    });
    if (found.length !== ids.length) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('warehouseIds', ERROR_CODE.INVALID, '없거나 쓰지 않는 창고가 있습니다.'),
      ]);
    }

    const current = await this.prisma.department_production_warehouse.findMany({
      where: { department_id: departmentId },
      select: { warehouse_id: true },
    });
    const kept = new Set(ids.map(String));
    const removedIds = current.map((row) => row.warehouse_id).filter((id) => !kept.has(String(id)));
    const removed = await this.activeRequestCounts(departmentId, removedIds);

    if (dryRun) return { items: sorted(found.map(view)), removed };

    await this.prisma.$transaction([
      this.prisma.department_production_warehouse.deleteMany({
        where: { department_id: departmentId, warehouse_id: { notIn: ids } },
      }),
      this.prisma.department_production_warehouse.createMany({
        data: ids.map((warehouseId) => ({
          department_id: departmentId,
          warehouse_id: warehouseId,
          created_by: appUserId ?? null,
        })),
        skipDuplicates: true,
      }),
    ]);
    return { items: await this.read(departmentId), removed };
  }

  /**
   * 뺄 창고가 출발지인 이 부서의 활성 요청 수. 다른 부서가 같은 창고를 쓰는 요청은 이 부서의 연결과
   * 상관없으므로 세지 않는다 — 부서는 W/O 생산 라인의 부서다.
   */
  private async activeRequestCounts(departmentId: number, warehouseIds: bigint[]): Promise<RemovedWarehouse[]> {
    if (warehouseIds.length === 0) return [];
    const counts = await this.prisma.material_issue_request.groupBy({
      by: ['source_warehouse_id'],
      where: {
        source_warehouse_id: { in: warehouseIds },
        status_code: { in: ACTIVE_REQUEST_STATUSES },
        closed_at: null,
        work_order: { production_line: { department_id: departmentId } },
      },
      _count: { _all: true },
    });
    const byWarehouse = new Map(counts.map((row) => [String(row.source_warehouse_id), row._count._all]));
    return warehouseIds
      .map((id) => ({ warehouseId: Number(id), activeRequestCount: byWarehouse.get(String(id)) ?? 0 }))
      .sort((a, b) => a.warehouseId - b.warehouseId);
  }

  private async assertDepartment(departmentId: number): Promise<void> {
    const count = await this.prisma.department.count({ where: { department_id: departmentId } });
    if (count === 0) throw new NotFoundException('없는 부서입니다.');
  }

  private async read(departmentId: number): Promise<ProductionWarehouseView[]> {
    const rows = await this.prisma.department_production_warehouse.findMany({
      where: { department_id: departmentId },
      select: {
        warehouse: { select: { warehouse_id: true, warehouse_code: true, warehouse_name: true, plant_id: true } },
      },
    });
    return sorted(rows.map(({ warehouse }) => view(warehouse)));
  }
}

function view(row: { warehouse_id: bigint; warehouse_code: string; warehouse_name: string; plant_id: bigint }): ProductionWarehouseView {
  return {
    warehouseId: Number(row.warehouse_id),
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    plantId: Number(row.plant_id),
  };
}

/** 공장 → 창고 코드 순 — 화면이 「공장 · 창고명」으로 줄을 세운다. */
function sorted(items: ProductionWarehouseView[]): ProductionWarehouseView[] {
  return items.sort((a, b) => a.plantId - b.plantId || a.warehouseCode.localeCompare(b.warehouseCode));
}
