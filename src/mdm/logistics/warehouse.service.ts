import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  Editability,
  PUTAWAY_STAGING,
  ReferenceQuery,
  Referrer,
  aliasOf,
  assertCodeValues,
  assertNotBlank,
  countReferences,
  erpWarehouseName,
  filter,
  optional,
  referencePage,
  referenceWhere,
} from '../../common/master';
import { assertErpWarehouse } from './erp-warehouse-rules';

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
  ['logistics.recycle_entry', 'warehouse_id'],
  ['logistics.shipment', 'warehouse_id'],
  ['logistics.stock_transfer', 'from_warehouse_id'],
  ['logistics.stock_transfer', 'to_warehouse_id'],
  ['mdm.location', 'warehouse_id'],
  ['mdm.terminal', 'warehouse_id'],
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
  isExternal: boolean;
  isDefect: boolean;
  isActive: boolean;
  /** MES 별칭 — 계약 밖(장부 P-148). */
  aliasName: string | null;
}

interface WarehouseCreate {
  plantId: number;
  businessUnitId: number;
  warehouseCode: string;
  warehouseName: string;
  warehouseTypeCode: string;
  isExternal?: boolean;
  isDefect?: boolean;
  partnerId?: number | null;
  /** 계약 밖이라 검증 가드가 보지 않는다 — `aliasOf` 가 본다. */
  aliasName?: unknown;
}

interface WarehouseUpdate {
  businessUnitId: number;
  warehouseCode: string;
  warehouseName: string;
  warehouseTypeCode: string;
  isExternal: boolean;
  isDefect: boolean;
  partnerId?: number | null;
  aliasName?: unknown;
}

export interface WarehouseQuery extends ReferenceQuery {
  plantId?: number;
  warehouseTypeCode?: string;
  isDefect?: boolean;
  dividedOnly?: boolean;
}

type WarehouseRow = Prisma.warehouseGetPayload<object>;

/** 관리수준은 없앴다(#884). 칸이 NOT NULL 이라 지울 때(#898)까지 자리만 채운다 — 아무도 읽지 않는다. */
const UNUSED_MANAGEMENT_LEVEL = 'NONE';

export type WarehouseResult = {
  warehouse: WarehouseView;
  editability: Editability;
  versionNo: number;
};

@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: WarehouseQuery, terminalPlantId?: bigint): Promise<PagedResponse<WarehouseView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'warehouse_code', name: 'warehouse_name' }, {
      // 단말 공장과 질의 공장을 «둘 다» 건다 — 단말이 남의 공장을 보내면 빈 목록이다(장부 P-109).
      AND: [
        terminalPlantId === undefined ? {} : { plant_id: terminalPlantId },
        filter('plant_id', query.plantId),
      ],
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

    const [references, systemLocations] = await Promise.all([
      countReferences(this.prisma, WAREHOUSE_REFERRERS, row.warehouse_id),
      // 서버가 만든 위치(장부 P-145)는 창고와 함께 생긴다 — 세면 모든 창고 코드가 처음부터 잠긴다.
      this.prisma.location.count({ where: { warehouse_id: row.warehouse_id, NOT: { system_role_code: null } } }),
    ]);
    const referenceCount = references - systemLocations;
    const fromErp = (await erpWarehouseName(this.prisma, row.warehouse_code)) !== null;
    return {
      warehouse: view(row),
      // 창고 코드를 «글자»로 부르는 자리는 계약에 0곳이라 FK 건수가 곧 답이다(#114 와 같다). ERP 창고는 늘 잠근다(장부 P-148).
      editability: {
        codeEditable: !fromErp && referenceCount === 0,
        reason: fromErp ? 'RECEIVED_FROM_ERP' : referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(input: WarehouseCreate): Promise<WarehouseView> {
    // 계약이 `WarehouseCreate.warehouseCode` 에 「공백만 불가」로 적었다.
    assertNotBlank([['warehouseCode', input.warehouseCode]]);
    assertNoPartner(input);
    const aliasName = aliasOf(input.aliasName);
    await this.assertCodes(input);
    await assertErpWarehouse(this.prisma, input, null);
    return view(
      await this.prisma.warehouse.create({
        data: {
          plant_id: input.plantId,
          business_unit_id: input.businessUnitId,
          warehouse_code: input.warehouseCode,
          warehouse_name: input.warehouseName,
          warehouse_type_code: input.warehouseTypeCode,
          management_level_code: UNUSED_MANAGEMENT_LEVEL,
          ...optional('is_external', input.isExternal),
          ...optional('is_defect', input.isDefect),
          ...optional('alias_name', aliasName),
        },
      }),
    );
  }

  async update(
    warehouseId: number,
    version: number,
    input: WarehouseUpdate,
  ): Promise<WarehouseResult> {
    assertNoPartner(input);
    const aliasName = aliasOf(input.aliasName);
    await this.assertCodes(input);
    const current = await this.prisma.warehouse.findUnique({
      where: { warehouse_id: warehouseId },
      select: { warehouse_code: true },
    });
    if (!current) throw new NotFoundException('없는 창고입니다.');
    await assertErpWarehouse(this.prisma, input, { warehouseId: BigInt(warehouseId), warehouseCode: current.warehouse_code });
    const updated = await this.prisma.warehouse.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { warehouse_id: warehouseId, version_no: version },
      data: {
        business_unit_id: input.businessUnitId,
        warehouse_code: input.warehouseCode,
        warehouse_name: input.warehouseName,
        warehouse_type_code: input.warehouseTypeCode,
        is_external: input.isExternal,
        is_defect: input.isDefect,
        ...optional('alias_name', aliasName),
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

  /**
   * 고를 수 있는 활성 위치가 둘 이상인 창고 — 적치 대기 자리(장부 P-145)는 놓기 전 자리라 세지 않는다.
   * 「창고 전체」는 센다 — 모든 창고에 생기므로(장부 P-153) 구역을 하나 만들면 둘이 된다.
   */
  private async dividedIds(): Promise<bigint[]> {
    const rows = await this.prisma.location.groupBy({
      by: ['warehouse_id'],
      // `not` 만 걸면 SQL `<>` 라 역할이 없는(NULL) 사람의 위치까지 빠진다.
      where: { is_active: true, OR: [{ system_role_code: null }, { system_role_code: { not: PUTAWAY_STAGING } }] },
      _count: { location_id: true },
      having: { location_id: { _count: { gt: 1 } } },
    });
    return rows.map((row) => row.warehouse_id);
  }

  private assertCodes(input: { warehouseTypeCode: string }): Promise<void> {
    return assertCodeValues(this.prisma, [
      { field: 'warehouseTypeCode', value: input.warehouseTypeCode, groupCode: 'WAREHOUSE_TYPE' },
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

/**
 * 창고에 거래처를 두지 않는다 — 받지도 저장하지도 않는다(사용자 결정 2026-10-29 · 장부 P-146). 외부창고 표시는 둔다.
 * 계약 칸이라 null 은 받는다. 다른 값을 무시하면 저장된 것처럼 보인다.
 */
function assertNoPartner(input: { partnerId?: number | null }): void {
  if (input.partnerId == null) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('partnerId', ERROR_CODE.INVALID, '창고에 거래처를 두지 않습니다.'),
  ]);
}

function view(row: WarehouseRow): WarehouseView {
  return {
    warehouseId: Number(row.warehouse_id),
    plantId: Number(row.plant_id),
    businessUnitId: Number(row.business_unit_id),
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    warehouseTypeCode: row.warehouse_type_code,
    isExternal: row.is_external,
    isDefect: row.is_defect,
    isActive: row.is_active,
    aliasName: row.alias_name,
  };
}
