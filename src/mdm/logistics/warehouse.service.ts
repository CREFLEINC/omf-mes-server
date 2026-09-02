import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertCodeValues } from '../code-reference';
import { optional } from '../column';
import { Editability } from '../editability';
import { Referrer, countReferences } from '../reference-count';
import { ReferenceQuery, referencePage, referenceWhere } from '../reference/reference.query';

/**
 * 창고를 FK 로 가리키는 자리 전부. `pg_constraint` 에서 뽑았고, e2e 가 같은 질의로
 * 다시 뽑아 대조한다 — FK 가 새로 붙으면 검사가 깨져서 드러난다.
 */
export const WAREHOUSE_REFERRERS: readonly Referrer[] = [
  ['inventory.handling_unit', 'warehouse_id'],
  ['inventory.inventory_balance', 'warehouse_id'],
  ['inventory.inventory_count', 'warehouse_id'],
  ['inventory.inventory_reservation', 'warehouse_id'],
  ['inventory.inventory_transaction_line', 'from_warehouse_id'],
  ['inventory.inventory_transaction_line', 'to_warehouse_id'],
  ['logistics.goods_issue', 'source_warehouse_id'],
  ['logistics.goods_receipt', 'warehouse_id'],
  ['logistics.picking_order', 'warehouse_id'],
  ['logistics.putaway_rule', 'warehouse_id'],
  ['logistics.shipment', 'warehouse_id'],
  ['logistics.stock_transfer', 'from_warehouse_id'],
  ['logistics.stock_transfer', 'to_warehouse_id'],
  ['mdm.location', 'warehouse_id'],
  ['mdm.warehouse_layout', 'warehouse_id'],
  ['production.material_return', 'destination_warehouse_id'],
];

/** 계약 `Warehouse` 와 동형. */
interface WarehouseView {
  warehouseId: number;
  plantId: number;
  businessUnitId: number;
  warehouseCode: string;
  warehouseName: string;
  warehouseTypeCode: string;
  managementLevelCode: string;
  isExternal: boolean;
  isDefect: boolean;
  partnerId: number | null;
  isActive: boolean;
}

interface WarehouseCreate {
  plantId: number;
  businessUnitId: number;
  warehouseCode: string;
  warehouseName: string;
  warehouseTypeCode: string;
  managementLevelCode: string;
  isExternal?: boolean;
  isDefect?: boolean;
  partnerId?: number | null;
}

interface WarehouseUpdate {
  businessUnitId: number;
  warehouseCode: string;
  warehouseName: string;
  warehouseTypeCode: string;
  managementLevelCode: string;
  isExternal: boolean;
  isDefect: boolean;
  partnerId?: number | null;
}

export interface WarehouseQuery extends ReferenceQuery {
  warehouseTypeCode?: string;
  isDefect?: boolean;
  dividedOnly?: boolean;
}

type WarehouseRow = Prisma.warehouseGetPayload<object>;

export type WarehouseResult = {
  warehouse: WarehouseView;
  editability: Editability;
  versionNo: number;
};

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: WarehouseQuery): Promise<PagedResponse<WarehouseView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'warehouse_code', name: 'warehouse_name' }, {
      ...(query.warehouseTypeCode === undefined
        ? {}
        : { warehouse_type_code: query.warehouseTypeCode }),
      ...(query.isDefect === undefined ? {} : { is_defect: query.isDefect }),
      // 「창고 안을 나눈 창고」 = 활성 위치가 «둘 이상»인 창고. 재고를 한 번이라도 받은
      // 창고는 기본 위치 한 행이 반드시 있으므로 「위치가 있는가」로는 갈리지 않는다
      // (계약이 그 이유를 적었다). 판정을 화면이 세지 않게 서버가 건다.
      ...(query.dividedOnly === true ? { warehouse_id: { in: await this.dividedIds() } } : {}),
    });
    const [rows, total] = await Promise.all([
      this.prisma.warehouse.findMany({
        where,
        // 창고 코드는 공장 안에서만 유일하다(uq_warehouse) — 공장을 앞세워 정렬한다.
        orderBy: [{ plant_id: 'asc' }, { warehouse_code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.warehouse.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(warehouseId: number): Promise<WarehouseResult> {
    const row = await this.prisma.warehouse.findUnique({ where: { warehouse_id: warehouseId } });
    if (!row) throw new NotFoundException('없는 창고입니다.');

    const referenceCount = await countReferences(
      this.prisma,
      WAREHOUSE_REFERRERS,
      row.warehouse_id,
    );
    return {
      warehouse: view(row),
      // 창고 코드를 «글자»로 부르는 자리는 계약에 0곳이라 FK 건수가 곧 답이다(#114 와 같다).
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(input: WarehouseCreate): Promise<WarehouseView> {
    await this.assertCodes(input);
    return view(
      await this.prisma.warehouse.create({
        data: {
          plant_id: input.plantId,
          business_unit_id: input.businessUnitId,
          warehouse_code: input.warehouseCode,
          warehouse_name: input.warehouseName,
          warehouse_type_code: input.warehouseTypeCode,
          management_level_code: input.managementLevelCode,
          ...optional('is_external', input.isExternal),
          ...optional('is_defect', input.isDefect),
          ...optional('partner_id', input.partnerId),
        },
      }),
    );
  }

  async update(
    warehouseId: number,
    version: number,
    input: WarehouseUpdate,
  ): Promise<WarehouseResult> {
    await this.assertCodes(input);
    const updated = await this.prisma.warehouse.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { warehouse_id: warehouseId, version_no: version },
      data: {
        business_unit_id: input.businessUnitId,
        warehouse_code: input.warehouseCode,
        warehouse_name: input.warehouseName,
        warehouse_type_code: input.warehouseTypeCode,
        management_level_code: input.managementLevelCode,
        is_external: input.isExternal,
        is_defect: input.isDefect,
        ...optional('partner_id', input.partnerId),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(warehouseId, updated.count);
    return this.get(warehouseId);
  }

  async setActive(
    warehouseId: number,
    version: number,
    isActive: boolean,
  ): Promise<WarehouseResult> {
    const updated = await this.prisma.warehouse.updateMany({
      where: { warehouse_id: warehouseId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(warehouseId, updated.count);
    return this.get(warehouseId);
  }

  /** 활성 위치가 둘 이상인 창고. */
  private async dividedIds(): Promise<bigint[]> {
    const rows = await this.prisma.location.groupBy({
      by: ['warehouse_id'],
      where: { is_active: true },
      _count: { location_id: true },
      having: { location_id: { _count: { gt: 1 } } },
    });
    return rows.map((row) => row.warehouse_id);
  }

  private assertCodes(input: {
    warehouseTypeCode: string;
    managementLevelCode: string;
  }): Promise<void> {
    return assertCodeValues(this.prisma, [
      { field: 'warehouseTypeCode', value: input.warehouseTypeCode, groupCode: 'WAREHOUSE_TYPE' },
      {
        field: 'managementLevelCode',
        value: input.managementLevelCode,
        groupCode: 'MANAGEMENT_LEVEL',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(warehouseId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.warehouse.findUnique({
      where: { warehouse_id: warehouseId },
      select: { warehouse_id: true },
    });
    if (!exists) throw new NotFoundException('없는 창고입니다.');
    assertUpdated(0);
  }
}

function view(row: WarehouseRow): WarehouseView {
  return {
    warehouseId: Number(row.warehouse_id),
    plantId: Number(row.plant_id),
    businessUnitId: Number(row.business_unit_id),
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    warehouseTypeCode: row.warehouse_type_code,
    managementLevelCode: row.management_level_code,
    isExternal: row.is_external,
    isDefect: row.is_defect,
    partnerId: row.partner_id === null ? null : Number(row.partner_id),
    isActive: row.is_active,
  };
}

