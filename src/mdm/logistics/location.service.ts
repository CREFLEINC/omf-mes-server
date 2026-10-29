import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertMove, assertNoStock, assertParentEmpty, assertSentLevel, levelUnder, parentError } from './location-hierarchy';
import { Editability, PUTAWAY_STAGING, ReferenceQuery, Referrer, aliasOf, assertCodeValues, countReferences, optional, referencePage, referenceWhere } from '../../common/master';

/**
 * 로케이션을 FK 로 가리키는 자리 전부다. `pg_constraint` 에서 뽑았고,
 * e2e 가 같은 질의로 다시 뽑아 대조한다(#116 과 같은 장치).
 */
export const LOCATION_REFERRERS: readonly Referrer[] = [
  ['inventory.handling_unit', 'location_id'],
  ['inventory.inventory_adjustment_line', 'location_id'],
  ['inventory.inventory_balance', 'location_id'],
  ['inventory.inventory_count_line', 'location_id'],
  ['inventory.inventory_reservation', 'location_id'],
  ['inventory.inventory_transaction_line', 'from_location_id'],
  ['inventory.inventory_transaction_line', 'to_location_id'],
  ['logistics.goods_issue_line', 'source_location_id'],
  ['logistics.goods_receipt_line', 'destination_location_id'],
  ['logistics.inbound_receipt', 'dock_location_id'],
  ['logistics.material_issue_request', 'destination_location_id'],
  ['logistics.picking_line', 'location_id'],
  ['logistics.putaway_rule', 'location_id'],
  ['logistics.putaway_task', 'actual_location_id'],
  ['logistics.putaway_task', 'from_location_id'],
  ['logistics.putaway_task', 'recommended_location_id'],
  ['logistics.recycle_entry', 'destination_location_id'],
  ['logistics.shopfloor_receipt', 'destination_location_id'],
  ['logistics.stock_transfer_line', 'from_location_id'],
  ['logistics.stock_transfer_line', 'to_location_id'],
  ['mdm.equipment', 'location_id'],
  ['mdm.location', 'parent_location_id'],
  ['mdm.production_line', 'default_fg_location_id'],
  ['mdm.production_line', 'default_scrap_location_id'],
  ['mdm.production_line', 'default_wip_location_id'],
  ['mdm.terminal', 'location_id'],
  ['production.material_return', 'source_location_id'],
  ['production.operation_handover_line', 'destination_location_id'],
  ['production.operation_handover_line', 'source_location_id'],
  ['production.work_order', 'default_fg_location_id'],
  ['production.work_order', 'default_scrap_location_id'],
  ['production.work_order', 'default_wip_location_id'],
  ['trace.lot_status_event', 'location_id'],
];

/** 계약 `Location` 과 동형. */
interface LocationView {
  locationId: number;
  warehouseId: number;
  parentLocationId: number | null;
  locationCode: string;
  locationName: string;
  locationTypeCode: string;
  qualityZoneCode: string | null;
  storageConditionCode: string | null;
  allowMixedItem: boolean;
  allowMixedLot: boolean;
  capacityQty: number | null;
  capacityUomId: number | null;
  isActive: boolean;
  /** 서버가 만든 위치의 역할 — 계약 밖(장부 P-145). 사람이 만든 위치는 null. */
  systemRoleCode: string | null;
  /** MES 별칭 — 계약 밖(장부 P-145). */
  aliasName: string | null;
  /** 구역·랙·층·셀 — 계약 밖(장부 P-153). 넷보다 깊던 옛 위치만 null. */
  locationLevelCode: string | null;
  /** 켜진 하위가 없다 — 재고를 둘 수 있는 맨 아래 위치. 계약 밖(장부 P-153). */
  isLeaf: boolean;
}

interface LocationWrite {
  parentLocationId?: number | null;
  locationCode: string;
  locationName: string;
  locationTypeCode: string;
  qualityZoneCode?: string | null;
  storageConditionCode?: string | null;
  allowMixedItem?: boolean;
  allowMixedLot?: boolean;
  capacityQty?: number | null;
  capacityUomId?: number | null;
  /** 계약 밖이라 검증 가드가 보지 않는다 — `aliasOf` 가 본다. */
  aliasName?: unknown;
  /** 계약 밖 · 선택 — 보냈으면 상위로 정해지는 단계와 같아야 한다(장부 P-153). */
  locationLevelCode?: unknown;
}

/** 서버가 만든 위치에서 바뀌어 오면 막는 칸 — 별칭만 고친다(사용자 결정 2026-10-29). */
const SYSTEM_KEPT = [
  'locationCode', 'locationName', 'locationTypeCode', 'parentLocationId', 'qualityZoneCode',
  'storageConditionCode', 'allowMixedItem', 'allowMixedLot', 'capacityQty', 'capacityUomId', 'locationLevelCode',
] as const;

export interface LocationQuery extends ReferenceQuery {
  warehouseId: number;
  locationCode?: string;
}

type LocationRow = Prisma.locationGetPayload<object>;

/** `isLeaf` 를 위해 켜진 하위 수를 함께 읽는다. */
const WITH_CHILDREN = {
  _count: { select: { child_locations: { where: { is_active: true } } } },
} satisfies Prisma.locationInclude;
type LocationWithChildren = Prisma.locationGetPayload<{ include: typeof WITH_CHILDREN }>;

export type LocationResult = {
  location: LocationView;
  editability: Editability;
  versionNo: number;
};

@Injectable()
export class LocationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: LocationQuery): Promise<PagedResponse<LocationView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'location_code', name: 'location_name' }, {
      // 계약이 warehouseId 를 필수로 두었다 — 「Location 은 창고를 고른 뒤에 본다」(G-8).
      warehouse_id: query.warehouseId,
      // 스캔한 코드로 한 건을 집는 자리라 정확 일치다. 부분 일치는 `q` 가 맡는다 —
      // 계약이 「q 로 받은 페이지를 화면이 걸러 쓰는 것으로는 성립하지 않는다」로 적었다.
      ...(query.locationCode === undefined ? {} : { location_code: query.locationCode }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.location.findMany({
        where,
        include: WITH_CHILDREN,
        orderBy: { location_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.location.count({ where }),
    ]);
    return pagedResponse(rows.map((row) => view(row, row._count.child_locations)), total, page);
  }

  async get(locationId: number): Promise<LocationResult> {
    const row: LocationWithChildren | null = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      include: WITH_CHILDREN,
    });
    if (!row) throw new NotFoundException('없는 위치입니다.');

    const referenceCount = await countReferences(this.prisma, LOCATION_REFERRERS, row.location_id);
    const systemOwned = row.system_role_code !== null;
    return {
      location: view(row, row._count.child_locations),
      editability: {
        codeEditable: !systemOwned && referenceCount === 0,
        reason: systemOwned ? 'SYSTEM_OWNED' : referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  async create(input: LocationWrite & { warehouseId: number }): Promise<LocationView> {
    const aliasName = aliasOf(input.aliasName);
    await this.assertWritable(input);
    const parentId = input.parentLocationId ?? null;
    if (parentId !== null) await this.assertParent(input.warehouseId, parentId, null);
    const level = await levelUnder(this.prisma, parentId);
    assertSentLevel(input.locationLevelCode, level);
    if (parentId !== null) await assertNoStock(this.prisma, parentId, 'parentLocationId');
    return view(
      await this.prisma.location.create({
        data: {
          warehouse_id: input.warehouseId,
          location_level_code: level,
          location_code: input.locationCode,
          location_name: input.locationName,
          location_type_code: input.locationTypeCode,
          ...optional('parent_location_id', input.parentLocationId),
          ...optional('quality_zone_code', input.qualityZoneCode),
          ...optional('storage_condition_code', input.storageConditionCode),
          ...optional('allow_mixed_item', input.allowMixedItem),
          ...optional('allow_mixed_lot', input.allowMixedLot),
          ...optional('capacity_qty', input.capacityQty),
          ...optional('capacity_uom_id', input.capacityUomId),
          ...optional('alias_name', aliasName),
        },
      }),
      0,
    );
  }

  async update(
    locationId: number,
    version: number,
    input: LocationWrite,
  ): Promise<LocationResult> {
    const aliasName = aliasOf(input.aliasName);
    const current = await this.prisma.location.findUnique({ where: { location_id: locationId } });
    if (!current) throw new NotFoundException('없는 위치입니다.');
    if (current.system_role_code !== null) return this.updateAlias(current, version, input, aliasName);
    await this.assertWritable(input);
    if (input.parentLocationId != null) {
      await this.assertParent(Number(current.warehouse_id), input.parentLocationId, locationId);
    }
    await assertMove(this.prisma, current, input);

    const updated = await this.prisma.location.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { location_id: locationId, version_no: version },
      data: {
        location_code: input.locationCode,
        location_name: input.locationName,
        location_type_code: input.locationTypeCode,
        ...optional('parent_location_id', input.parentLocationId),
        ...optional('quality_zone_code', input.qualityZoneCode),
        ...optional('storage_condition_code', input.storageConditionCode),
        ...optional('allow_mixed_item', input.allowMixedItem),
        ...optional('allow_mixed_lot', input.allowMixedLot),
        ...optional('capacity_qty', input.capacityQty),
        ...optional('capacity_uom_id', input.capacityUomId),
        ...optional('alias_name', aliasName),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(locationId, updated.count);
    return this.get(locationId);
  }

  /** 서버가 만든 위치 — 코드·이름은 서버가 정한 값이라 별칭만 고친다. 다른 칸이 바뀌어 오면 무시하지 않고 막는다. */
  private async updateAlias(
    current: LocationRow, version: number, input: LocationWrite, aliasName: string | null | undefined,
  ): Promise<LocationResult> {
    const stored = view(current, 0);
    const errors = SYSTEM_KEPT.filter((key) => input[key] !== undefined && input[key] !== stored[key]).map(
      (key): ErrorItem => ({
        scope: 'field', field: key, code: ERROR_CODE.STATE_LOCKED, message: '서버가 만든 위치는 별칭만 고칠 수 있습니다.',
      }),
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    const locationId = Number(current.location_id);
    const updated = await this.prisma.location.updateMany({
      where: { location_id: locationId, version_no: version },
      data: { ...optional('alias_name', aliasName), version_no: { increment: 1 } },
    });
    await this.assertExists(locationId, updated.count);
    return this.get(locationId);
  }

  async setActive(locationId: number, version: number, isActive: boolean): Promise<LocationResult> {
    if (!isActive) await this.assertNotStaging(locationId);
    if (isActive) await assertParentEmpty(this.prisma, locationId);
    const updated = await this.prisma.location.updateMany({
      where: { location_id: locationId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(locationId, updated.count);
    return this.get(locationId);
  }

  /** 공통코드 세 칸과 용량 짝을 함께 본다 — 둘 다 400 이므로 한 번에 모아 낸다. */
  private async assertWritable(input: LocationWrite): Promise<void> {
    // ⛔ ck_location_capacity 는 `(qty IS NULL) = (uom IS NULL)` 이다. 한쪽만 보내면
    // DB 가 막지만 어느 칸이 문제인지 못 짚는다 — 화면은 둘 중 하나를 지워야 한다.
    if ((input.capacityQty == null) !== (input.capacityUomId == null)) {
      const error: ErrorItem = {
        scope: 'field',
        field: input.capacityQty == null ? 'capacityQty' : 'capacityUomId',
        code: ERROR_CODE.PAIR,
        message: '용량과 단위는 함께 넣거나 함께 비웁니다.',
      };
      throw new ContractException(HttpStatus.BAD_REQUEST, [error]);
    }

    await assertCodeValues(this.prisma, [
      { field: 'locationTypeCode', value: input.locationTypeCode, groupCode: 'LOCATION_TYPE' },
      { field: 'qualityZoneCode', value: input.qualityZoneCode, groupCode: 'QUALITY_ZONE' },
      {
        field: 'storageConditionCode',
        value: input.storageConditionCode,
        groupCode: 'STORAGE_CONDITION',
      },
    ]);
  }

  /**
   * 상위 위치를 검사한다. 물리 제약이 **하나도 없는** 자리다 —
   * `ck_department_parent` 같은 것조차 없어 자기 자신을 상위로 둘 수도 있다.
   *
   * 창고가 같아야 한다는 것은 계약에 없다. 서버가 정했다 — 목록이 창고 단위로만
   * 열리므로(`warehouseId` 필수) 다른 창고의 자식은 어느 화면에서도 안 보인다.
   */
  private async assertParent(
    warehouseId: number,
    parentId: number,
    selfId: number | null,
  ): Promise<void> {
    if (selfId !== null && parentId === selfId) {
      throw parentError('자기 자신을 상위로 둘 수 없습니다.');
    }

    const seen = new Set<number>(selfId === null ? [] : [selfId]);
    let current: number | null = parentId;
    while (current !== null) {
      if (seen.has(current)) {
        throw parentError('상위 위치로 지정하면 위치 계층에 순환이 생깁니다.');
      }
      seen.add(current);

      const row: { warehouse_id: bigint; parent_location_id: bigint | null } | null =
        await this.prisma.location.findUnique({
          where: { location_id: current },
          select: { warehouse_id: true, parent_location_id: true },
        });
      if (row === null) throw parentError('없는 위치입니다.');
      if (Number(row.warehouse_id) !== warehouseId) throw parentError('다른 창고의 위치입니다.');

      current = row.parent_location_id === null ? null : Number(row.parent_location_id);
    }
  }

  /** 적치 대기 자리는 입고 기본 위치다 — 끄면 그 창고의 입고 기본값이 빈다. 「창고 전체」는 사람이 끈다. */
  private async assertNotStaging(locationId: number): Promise<void> {
    const row = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { system_role_code: true },
    });
    if (row?.system_role_code !== PUTAWAY_STAGING) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '적치 대기 자리는 끌 수 없습니다.' },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(locationId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { location_id: true },
    });
    if (!exists) throw new NotFoundException('없는 위치입니다.');
    assertUpdated(0);
  }
}

function view(row: LocationRow, activeChildren: number): LocationView {
  return {
    locationId: Number(row.location_id),
    warehouseId: Number(row.warehouse_id),
    parentLocationId: row.parent_location_id === null ? null : Number(row.parent_location_id),
    locationCode: row.location_code,
    locationName: row.location_name,
    locationTypeCode: row.location_type_code,
    qualityZoneCode: row.quality_zone_code,
    storageConditionCode: row.storage_condition_code,
    allowMixedItem: row.allow_mixed_item,
    allowMixedLot: row.allow_mixed_lot,
    capacityQty: row.capacity_qty === null ? null : Number(row.capacity_qty),
    capacityUomId: row.capacity_uom_id === null ? null : Number(row.capacity_uom_id),
    isActive: row.is_active,
    systemRoleCode: row.system_role_code,
    aliasName: row.alias_name,
    locationLevelCode: row.location_level_code,
    isLeaf: activeChildren === 0,
  };
}
