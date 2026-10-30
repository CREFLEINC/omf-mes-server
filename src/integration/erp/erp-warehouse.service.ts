import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';

/** ERP 창고는 공통코드 그룹 `SL_TYPE`(창고구분)으로 온다 — 공장 칸은 늘 비어 온다(`relay-tables.ts` COMMON_CODE). */
const SL_TYPE = 'SL_TYPE';

/** 가드가 계약대로 검사하고 형을 바꿔 넘긴 질의. */
export interface ErpWarehouseQuery {
  q?: string;
  plantId?: number;
  paired?: boolean;
  includeInactive?: boolean;
  page?: number;
  size?: number;
}

interface MesWarehouse {
  warehouseId: number;
  plantId: number;
  plantCode: string;
  plantName: string;
  warehouseName: string;
  isActive: boolean;
}

/** 장부 P-147. */
export interface ErpWarehouseRow {
  erpWarehouseCode: string;
  erpWarehouseName: string;
  erpActive: boolean;
  erpUpdatedAt: string;
  /** 같은 코드의 MES 창고 — 없으면 null(「MES 창고 없음」). 코드 하나에 MES 창고 하나다(사용자 결정 2026-10-29). */
  mesWarehouse: MesWarehouse | null;
}

interface ParsedQuery {
  q?: string;
  plantId?: bigint;
  paired?: boolean;
  includeInactive: boolean;
}

/**
 * ERP 창고 목록 — 「ERP 연동 현황·이력 > 창고」(W-06-10). ERP 에 공장이 없어 MES 창고는 사람이 공장을 골라
 * 만든다(사용자 결정 2026-10-29). 그래서 ERP 코드마다 한 줄을 내고 같은 코드의 MES 창고를 짝지어 싣는다.
 */
@Injectable()
export class ErpWarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  async list(raw: ErpWarehouseQuery): Promise<PagedResponse<ErpWarehouseRow>> {
    const query = parse(raw);
    const page = pageRequest({ page: raw.page, size: raw.size });
    const where: Prisma.code_valueWhereInput = {
      code_group: { group_code: SL_TYPE },
      ...(query.includeInactive ? {} : { is_active: true }),
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { code_name: { contains: query.q, mode: 'insensitive' } },
            ],
          }),
      AND: await this.pairing(query),
    };
    const [rows, total] = await Promise.all([
      this.prisma.code_value.findMany({
        where,
        select: { code: true, code_name: true, is_active: true, updated_at: true },
        orderBy: { code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.code_value.count({ where }),
    ]);
    const paired = await this.mesWarehouses(rows.map((row) => row.code));
    return pagedResponse(
      rows.map((row) => ({
        erpWarehouseCode: row.code,
        erpWarehouseName: row.code_name,
        erpActive: row.is_active,
        erpUpdatedAt: row.updated_at.toISOString(),
        mesWarehouse: paired.get(row.code) ?? null,
      })),
      total,
      page,
    );
  }

  /** 짝 조건은 코드로만 맞춘다 — 공통코드와 창고 사이에 FK 가 없다. */
  private async pairing(query: ParsedQuery): Promise<Prisma.code_valueWhereInput[]> {
    const conditions: Prisma.code_valueWhereInput[] = [];
    if (query.paired !== undefined) {
      const codes = await this.warehouseCodes();
      conditions.push({ code: query.paired ? { in: codes } : { notIn: codes } });
    }
    if (query.plantId !== undefined) conditions.push({ code: { in: await this.warehouseCodes(query.plantId) } });
    return conditions;
  }

  private async warehouseCodes(plantId?: bigint): Promise<string[]> {
    const rows = await this.prisma.warehouse.findMany({
      where: plantId === undefined ? {} : { plant_id: plantId },
      select: { warehouse_code: true },
      distinct: ['warehouse_code'],
    });
    return rows.map((row) => row.warehouse_code);
  }

  /** 같은 코드가 공장 둘에 있으면(결정 전 자료) 먼저 만든 것을 낸다. */
  private async mesWarehouses(codes: string[]): Promise<Map<string, MesWarehouse>> {
    const rows = await this.prisma.warehouse.findMany({
      where: { warehouse_code: { in: codes } },
      select: {
        warehouse_id: true,
        warehouse_code: true,
        warehouse_name: true,
        is_active: true,
        plant: { select: { plant_id: true, plant_code: true, plant_name: true } },
      },
      orderBy: { warehouse_id: 'asc' },
    });
    const byCode = new Map<string, MesWarehouse>();
    for (const row of rows) {
      if (byCode.has(row.warehouse_code)) continue;
      byCode.set(row.warehouse_code, {
        warehouseId: Number(row.warehouse_id),
        plantId: Number(row.plant.plant_id),
        plantCode: row.plant.plant_code,
        plantName: row.plant.plant_name,
        warehouseName: row.warehouse_name,
        isActive: row.is_active,
      });
    }
    return byCode;
  }
}

/** id 는 bigint 로 옮기고 빈 `q` 는 없는 것으로 본다. 가드는 계약 `default` 를 채우지 않는다 — 기본값은 여기서 건다. */
function parse(raw: ErpWarehouseQuery): ParsedQuery {
  const q = raw.q?.trim();
  return {
    q: q === '' ? undefined : q,
    plantId: raw.plantId === undefined ? undefined : BigInt(raw.plantId),
    paired: raw.paired,
    includeInactive: raw.includeInactive ?? false,
  };
}
