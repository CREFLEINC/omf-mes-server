import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { lockWarehouse, issueCode } from './location-code';
import { assertKeptPlace, assertNoStock, assertParentEmpty, assertSentLevel, levelUnder, parentError } from './location-hierarchy';
import { Editability, PUTAWAY_STAGING, ReferenceQuery, Referrer, aliasOf, countReferences, optional, referencePage, referenceWhere } from '../../common/master';

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
  isActive: boolean;
  aliasName: string | null;
  locationLevelCode: string | null;
  isLeaf: boolean;
  systemRoleCode: string | null;
}

/** 계약 `LocationUpdate` — 이름과 별칭만 바꾼다. 상위·단계는 같은 값이면 받아 준다(화면이 저장된 값을 실어 보낸다). */
interface LocationWrite {
  locationName: string;
  aliasName?: unknown;
  parentLocationId?: number | null;
  locationLevelCode?: unknown;
}

/** 서버가 만든 위치에서 바뀌어 오면 막는 칸 — 별칭만 고친다(사용자 결정 2026-10-29). */
const SYSTEM_KEPT = ['locationName', 'parentLocationId', 'locationLevelCode'] as const;

export interface LocationQuery extends ReferenceQuery {
  warehouseId: number;
  locationCode?: string;
  parentLocationId?: number;
  locationLevelCode?: string;
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
      // 수천 건인 창고를 구역 → 랙 → 층·셀 순으로 펼쳐 받는다.
      ...(query.parentLocationId === undefined ? {} : { parent_location_id: query.parentLocationId }),
      ...(query.locationLevelCode === undefined ? {} : { location_level_code: query.locationLevelCode }),
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
    return {
      location: view(row, row._count.child_locations),
      // 코드는 서버가 발행해 바꾸지 않는다(사용자 결정 2026-10-29).
      editability: {
        codeEditable: false,
        reason: row.system_role_code === null ? 'AUTO_ISSUED' : 'SYSTEM_OWNED',
        referenceCount,
      },
      versionNo: row.version_no,
    };
  }

  /** 코드는 서버가 발행한다 — 본문에 실려 와도 쓰지 않는다. */
  async create(input: LocationWrite & { warehouseId: number }): Promise<LocationView> {
    const aliasName = aliasOf(input.aliasName);
    const parentId = input.parentLocationId ?? null;
    if (parentId !== null) await this.assertParent(input.warehouseId, parentId, null);
    const level = await levelUnder(this.prisma, parentId);
    assertSentLevel(input.locationLevelCode, level);
    if (parentId !== null) await assertNoStock(this.prisma, parentId, 'parentLocationId');
    const parent = parentId === null ? null : await this.prisma.location.findUniqueOrThrow({
      where: { location_id: parentId },
      select: { location_code: true },
    });
    const row = await this.prisma.$transaction(async (tx) => {
      await lockWarehouse(tx, input.warehouseId);
      const code = await issueCode(
        tx, input.warehouseId, parent === null ? null : { locationId: parentId as number, locationCode: parent.location_code }, level,
      );
      return tx.location.create({
        data: {
          warehouse_id: input.warehouseId,
          parent_location_id: parentId,
          location_level_code: level,
          location_code: code,
          location_name: input.locationName,
          ...optional('alias_name', aliasName),
        },
      });
    });
    return view(row, 0);
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
    assertKeptPlace(current, input);

    const updated = await this.prisma.location.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { location_id: locationId, version_no: version },
      data: {
        location_name: input.locationName,
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
    isActive: row.is_active,
    aliasName: row.alias_name,
    locationLevelCode: row.location_level_code,
    isLeaf: activeChildren === 0,
    systemRoleCode: row.system_role_code,
  };
}
