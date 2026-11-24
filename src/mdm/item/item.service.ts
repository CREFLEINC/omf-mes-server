import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { loadStockUomTable, toStockUom } from '../../core/bom/stock-uom';
import { PrismaService } from '../../prisma/prisma.service';
import { ensureItemIqcPlan } from '../../quality/inspection-plan/item-iqc-plan-sync';
import { Editability, ReferenceQuery, assertCodeValues, optional, referencePage, referenceWhere } from '../../common/master';

/** 계약 `Item` 과 동형. 위(ERP 원본)와 아래(MES 확장)를 화면이 나눠 그린다. */
interface ItemView {
  itemId: number;
  itemCode: string;
  itemName: string;
  nameKo: string | null;
  nameVi: string | null;
  itemTypeCode: string;
  baseUomId: number;
  lotControlled: boolean;
  serialControlTypeCode: string;
  shelfLifeDays: number | null;
  inspectionRequired: boolean;
  fifoPolicyCode: string;
  negativeStockAllowed: boolean;
  storageConditionCode: string | null;
  openedShelfLifeHours: number | null;
  isActive: boolean;
  mesCategoryCode?: string;
  developmentItem: boolean;
  defaultLotStorageUomId: number | null;
  /** 품목유형별 LOT 기본크기 — 계약 밖 이름(장부 P-139). 전환 동안 옛 이름에도 같은 값을 싣는다. */
  defaultLotSize: number | null;
  defaultProductionLotSize: number | null;
  defaultPackageUomId: number | null;
  defaultPackageCount: number | null;
  erpSpec: string | null;
  erpItemGroupCode: string | null;
}

export interface ItemUpdate {
  lotControlled: boolean;
  serialControlTypeCode: string;
  shelfLifeDays?: number | null;
  inspectionRequired: boolean;
  fifoPolicyCode: string;
  negativeStockAllowed: boolean;
  storageConditionCode?: string | null;
  openedShelfLifeHours?: number | null;
  isActive: boolean;
  developmentItem?: boolean;
  defaultLotStorageUomId?: number | null;
  /** 위와 같다 — 옛 이름도 받는다. 둘 다 오면 같아야 한다. */
  defaultLotSize?: unknown;
  defaultProductionLotSize?: number | null;
  /** 둘은 함께 있거나 함께 비고, LOT 기본크기 ÷ 패키징 수량(봉지당 양)이 소수 1자리까지 떨어져야 한다(피처 014 FR-018). */
  defaultPackageUomId?: number | null;
  defaultPackageCount?: number | null;
  nameKo?: string | null;
  nameVi?: string | null;
}

export interface ItemQuery extends ReferenceQuery {
  itemTypeCode?: string[];
  hasRouting?: boolean;
  /** 가장 최근 Rev 의 상태(#231) — 계약 enum 이 DRAFT · CONFIRMED · OBSOLETE 로 막는다. */
  latestRoutingStatus?: string;
  /** 계약에 없는 조건이라 검증 가드가 불리언으로 바꾸지 않는다 — 문자열로 온다(장부 P-130). */
  hasBom?: string;
  /** 위와 같다 — 문자열로 온다(장부 P-138). */
  inspectionRequired?: string;
}

type ItemRow = Prisma.itemGetPayload<object>;

/**
 * ⛔ 계약이 못박았다 — 「`editability` 는 `itemCode` 등 ERP 원본 필드가 «항상 잠김»임을
 * 알린다(`RECEIVED_FROM_ERP`)」.
 *
 * 원본 필드는 `ItemUpdate` 에 **자리 자체가 없다.** 계약이 그렇게 만들어 두어, 행 단위
 * 출처 표시(부서의 `source_system_code` 같은 것) 없이도 잠금이 구조로 성립한다.
 */
const ITEM_EDITABILITY: Editability = {
  codeEditable: false,
  reason: 'RECEIVED_FROM_ERP',
  referenceCount: null,
};

@Injectable()
export class ItemService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ItemQuery): Promise<PagedResponse<ItemView>> {
    const page = referencePage(query);
    const latestStatusItemIds =
      query.latestRoutingStatus === undefined
        ? undefined
        : await this.itemIdsByLatestRoutingStatus(query.latestRoutingStatus);
    const where = referenceWhere(query, { code: 'item_code', name: 'item_name' }, {
      // 공정 경로 관리 품목 목록의 진행 상태 칩(omf-all-around#231) — 가장 최근 Rev 의 상태.
      ...(latestStatusItemIds === undefined ? {} : { item_id: { in: latestStatusItemIds } }),
      ...(query.itemTypeCode === undefined ? {} : { item_type_code: { in: query.itemTypeCode } }),
      // 「Routing 미보유 품목 필터를 제공해 보강 등록을 돕는다」(W-06-01 §6). 이것이
      // 없으면 화면이 전 품목과 전 Routing 을 받아 스스로 대조해야 한다.
      ...(query.hasRouting === undefined
        ? {}
        : { routing: query.hasRouting ? { some: {} } : { none: {} } }),
      // ERP 연동 현황 › BOM 탭의 모품목 목록 — 이 품목을 모품목으로 하는 BOM 이 있는가.
      ...withBom(query.hasBom),
      ...flagWhere('inspectionRequired', query.inspectionRequired, (on) => ({ inspection_required: on })),
    });
    const [rows, total] = await Promise.all([
      this.prisma.item.findMany({
        where,
        orderBy: { item_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.item.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  /**
   * 가장 최근 Rev(routing_version 이 가장 큰 개정)의 상태가 `status` 인 품목들.
   * 「최근」을 열끼리 견주는 조건은 Prisma where 로 적을 수 없어, 품목마다 최근 Rev 한 줄만 받아 거른다.
   */
  private async itemIdsByLatestRoutingStatus(status: string): Promise<bigint[]> {
    const latest = await this.prisma.routing.findMany({
      distinct: ['item_id'],
      orderBy: [{ item_id: 'asc' }, { routing_version: 'desc' }],
      select: { item_id: true, status_code: true },
    });
    return latest.filter((row) => row.status_code === status).map((row) => row.item_id);
  }

  async get(
    itemId: number,
  ): Promise<{ item: ItemView; editability: Editability; versionNo: number }> {
    const row = await this.prisma.item.findUnique({ where: { item_id: itemId } });
    if (!row) throw new NotFoundException('없는 품목입니다.');
    return { item: view(row), editability: ITEM_EDITABILITY, versionNo: row.version_no };
  }

  /**
   * MES 확장 속성만 고친다. 원본(`item_code`·`item_name`·`item_type_code`·`base_uom_id`)은
   * 여기에 자리가 없다 — 계약이 그렇게 갈랐다(QA #34).
   *
   * `:deactivate` 가 없고 `isActive` 를 이 본문으로 바꾼다. 품목에는 사용 중지 액션이
   * 화면에 따로 없다(계약이 그 이유를 적었다).
   */
  async update(
    itemId: number,
    version: number,
    input: ItemUpdate,
  ): Promise<{ item: ItemView; editability: Editability; versionNo: number }> {
    await this.assertWritable(input);
    const lotSize = lotSizeOf(input);

    const updated = await this.prisma.$transaction(async (tx) => {
      await assertPackageDefault(tx, itemId, input, lotSize);
      const before = await tx.item.findUnique({
        where: { item_id: itemId },
        select: { item_id: true, item_code: true, item_name: true, inspection_required: true },
      });
      const result = await tx.item.updateMany({
        // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
        where: { item_id: itemId, version_no: version },
        data: {
          lot_controlled: input.lotControlled,
          serial_control_type_code: input.serialControlTypeCode,
          inspection_required: input.inspectionRequired,
          fifo_policy_code: input.fifoPolicyCode,
          negative_stock_allowed: input.negativeStockAllowed,
          is_active: input.isActive,
          ...optional('shelf_life_days', input.shelfLifeDays),
          ...optional('storage_condition_code', input.storageConditionCode),
          ...optional('opened_shelf_life_hours', input.openedShelfLifeHours),
          ...optional('is_development_item', input.developmentItem),
          ...optional('default_lot_storage_uom_id', input.defaultLotStorageUomId),
          ...optional('default_production_lot_size', lotSize),
          ...optional('default_package_uom_id', input.defaultPackageUomId),
          ...optional('default_package_count', input.defaultPackageCount),
          ...optional('name_ko', input.nameKo),
          ...optional('name_vi', input.nameVi),
          version_no: { increment: 1 },
        },
      });
      if (result.count > 0) {
        // 그 품목 전용 IQC 기준의 「기본 생략」을 「수입검사 대상」의 반대로 맞춘다 — 두 설정은 같은 뜻이다(omf-all-around#215).
        // 공통 기준(품목 없음)은 맞추지 않는다. 이미 맞는 기준은 건드리지 않는다(기준 화면의 저장 토큰을 지킨다).
        const skip = !input.inspectionRequired;
        await tx.inspection_plan.updateMany({
          where: { item_id: itemId, inspection_type_code: 'IQC', is_active: true, default_skip: !skip },
          data: { default_skip: skip, pqc_skip_allowed: skip, version_no: { increment: 1 } },
        });
        // 전용 기준이 없는 품목에서 바꿨으면 전용 기준을 만들어 이 설정을 고정한다 — 공통 기준 저장이 덮지 않게(사용자 결정 2026-11-04).
        if (before !== null && before.inspection_required !== input.inspectionRequired) {
          await ensureItemIqcPlan(tx, before, skip);
        }
      }
      return result;
    });
    await this.assertExists(itemId, updated.count);
    return this.get(itemId);
  }

  private async assertWritable(input: ItemUpdate): Promise<void> {
    // ⭐ 확정 QA #28 — 「유효기한 관리 품목 = FEFO, 나머지 = FIFO」. 「유효기한 관리」는
    // 별도 컬럼이 아니라 `shelfLifeDays` 의 NULL 여부로 표현한다(계약 §8-2).
    //
    // 어긋나도 DB 는 통과시킨다. 그러면 유효기한이 있는 품목을 FIFO 로 불출해 «먼저
    // 만료될 재고를 뒤로 미룬다» — 창고에서 폐기가 나기 전까지 아무도 모른다.
    const managesShelfLife = input.shelfLifeDays != null;
    const expected = managesShelfLife ? 'FEFO' : 'FIFO';
    if (input.fifoPolicyCode !== expected) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'fifoPolicyCode',
          code: ERROR_CODE.PAIR,
          message: managesShelfLife
            ? '유효기한을 관리하는 품목은 FEFO 여야 합니다.'
            : '유효기한을 관리하지 않는 품목은 FIFO 여야 합니다.',
        },
      ]);
    }

    await assertCodeValues(this.prisma, [
      {
        field: 'serialControlTypeCode',
        value: input.serialControlTypeCode,
        groupCode: 'SERIAL_CONTROL_TYPE',
      },
      { field: 'fifoPolicyCode', value: input.fifoPolicyCode, groupCode: 'FIFO_POLICY' },
      {
        field: 'storageConditionCode',
        value: input.storageConditionCode,
        groupCode: 'STORAGE_CONDITION',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(itemId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.item.findUnique({
      where: { item_id: itemId },
      select: { item_id: true },
    });
    if (!exists) throw new NotFoundException('없는 품목입니다.');
    assertUpdated(0);
  }
}

function view(row: ItemRow): ItemView {
  const lotSize = row.default_production_lot_size === null ? null : Number(row.default_production_lot_size);
  return {
    itemId: Number(row.item_id),
    itemCode: row.item_code,
    itemName: row.item_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    itemTypeCode: row.item_type_code,
    baseUomId: Number(row.base_uom_id),
    lotControlled: row.lot_controlled,
    serialControlTypeCode: row.serial_control_type_code,
    shelfLifeDays: row.shelf_life_days,
    inspectionRequired: row.inspection_required,
    fifoPolicyCode: row.fifo_policy_code,
    negativeStockAllowed: row.negative_stock_allowed,
    storageConditionCode: row.storage_condition_code,
    openedShelfLifeHours: row.opened_shelf_life_hours,
    isActive: row.is_active,
    // 계약이 `["string"]` 으로 두고 required 에 넣지 않았다 — 비면 칸 자체를 뺀다.
    ...(row.mes_category_code === null ? {} : { mesCategoryCode: row.mes_category_code }),
    developmentItem: row.is_development_item,
    defaultLotStorageUomId:
      row.default_lot_storage_uom_id === null ? null : Number(row.default_lot_storage_uom_id),
    defaultLotSize: lotSize,
    defaultProductionLotSize: lotSize,
    defaultPackageUomId: row.default_package_uom_id === null ? null : Number(row.default_package_uom_id),
    defaultPackageCount: row.default_package_count,
    erpSpec: row.erp_spec,
    erpItemGroupCode: row.erp_item_group_code,
  };
}

function withBom(value: string | undefined): Prisma.itemWhereInput {
  return flagWhere('hasBom', value, (on) => ({ bom: on ? { some: {} } : { none: {} } }));
}

function flagWhere(
  field: string,
  value: string | undefined,
  where: (on: boolean) => Prisma.itemWhereInput,
): Prisma.itemWhereInput {
  if (value === undefined) return {};
  // ⛔ 틀린 값을 무시하지 않는다 — 걸러지지 않은 전 품목이 걸러진 것처럼 보인다.
  if (value !== 'true' && value !== 'false') {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field, code: ERROR_CODE.INVALID, message: `${field} 은 true 또는 false 여야 합니다.` },
    ]);
  }
  return where(value === 'true');
}

/** 새 이름은 계약 밖이라 검증 가드가 보지 않는다 — 계약이 옛 이름에 건 `> 0` 을 여기서 건다. */
function lotSizeOf(input: ItemUpdate): number | null | undefined {
  const value = input.defaultLotSize;
  if (value === undefined) return input.defaultProductionLotSize;
  const invalid = (message: string): ContractException =>
    new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field: 'defaultLotSize', code: ERROR_CODE.INVALID, message },
    ]);
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
    throw invalid('defaultLotSize 는 0 보다 큰 수이거나 null 이어야 합니다.');
  }
  // 전환 중 두 이름을 함께 싣는 화면이 있다 — 어긋나면 어느 쪽도 고르지 않는다.
  if (input.defaultProductionLotSize !== undefined && input.defaultProductionLotSize !== value) {
    throw invalid('defaultLotSize 와 defaultProductionLotSize 가 다릅니다.');
  }
  return value;
}

const PACKAGE_NOT_DIVISIBLE = '패키징 수량이 부적합 합니다. 자재 LOT 기본크기를 정확히 나눌 수 있는 값을 입력해주세요.';

/**
 * 패키징 기본값 — 보내지 않은 칸은 저장된 값으로 채워 «저장 뒤 모양»을 본다(기본크기만 바꿔도 나눔을 다시 본다).
 * 기본크기는 보관 단위 값 그대로 나눈다 — 비어 있으면 자동 생성이 어차피 멈추므로(`NO_DEFAULT`) 검사하지 않는다.
 * 봉지당 양은 소수 1자리까지 허용한다(사용자 결정 2026-11-24) — 「기본크기 × 10 mod 패키징 수량 = 0」(2.5 ÷ 5 = 0.5 통과, 2.5 ÷ 2 = 1.25 막힘).
 * 보관 단위 ≠ 기본 단위이고 환산이 있으면, 자동 생성이 실제로 쓰는 「기본 단위로 바꾼 크기 ÷ 패키징 수」도 소수 6자리(`qty_per_package`
 * scale) 안에서 딱 떨어져야 한다(피처 014 T049) — 떨어지지 않으면 자동 생성이 패키징 없이 만들기 때문이다. 환산이 없으면(NO_CONVERSION)
 * 자동 생성이 어차피 멈추므로 이 검사는 건너뛴다.
 */
async function assertPackageDefault(
  prisma: Prisma.TransactionClient,
  itemId: number,
  input: ItemUpdate,
  lotSize: number | null | undefined,
): Promise<void> {
  if (input.defaultPackageUomId === undefined && input.defaultPackageCount === undefined && lotSize === undefined) return;
  const stored = await prisma.item.findUnique({
    where: { item_id: itemId },
    select: { default_package_uom_id: true, default_package_count: true, default_production_lot_size: true, default_lot_storage_uom_id: true },
  });
  if (stored === null) return;
  const storageUomId = input.defaultLotStorageUomId === undefined ? stored.default_lot_storage_uom_id : input.defaultLotStorageUomId;
  const uomId = input.defaultPackageUomId === undefined ? stored.default_package_uom_id : input.defaultPackageUomId;
  const count = input.defaultPackageCount === undefined ? stored.default_package_count : input.defaultPackageCount;
  const size = lotSize === undefined ? stored.default_production_lot_size : lotSize;
  const reject = (fieldName: string, code: string, message: string): ContractException =>
    new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field: fieldName, code, message }]);
  if ((uomId === null) !== (count === null)) {
    throw reject(uomId === null ? 'defaultPackageUomId' : 'defaultPackageCount', ERROR_CODE.PAIR,
      '패키징 단위와 LOT 당 패키징 수량은 함께 넣거나 함께 비워야 합니다.');
  }
  if (count === null || uomId === null) return;
  if (input.defaultPackageUomId !== undefined && input.defaultPackageUomId !== null) {
    const uom = await prisma.uom.findUnique({ where: { uom_id: input.defaultPackageUomId }, select: { uom_id: true } });
    if (uom === null) throw reject('defaultPackageUomId', ERROR_CODE.INVALID, '없는 단위입니다.');
  }
  if (size !== null && !new Prisma.Decimal(size).times(10).mod(count).isZero()) {
    throw reject('defaultPackageCount', ERROR_CODE.INVALID, PACKAGE_NOT_DIVISIBLE);
  }
  if (size !== null && storageUomId !== null && !await baseSizeDivides(prisma, itemId, BigInt(storageUomId), new Prisma.Decimal(size), count)) {
    throw reject('defaultPackageCount', ERROR_CODE.INVALID, PACKAGE_NOT_DIVISIBLE);
  }
}

/**
 * 기본 단위로 바꾼 LOT 크기 ÷ 패키징 수가 소수 6자리 안에서 딱 떨어지는가 — 자동 생성(`material-lot-po-plan` packageSizeOf)과 같은 셈.
 * 보관 단위 = 기본 단위면 위의 소수 1자리 규칙으로 이미 충분하고, 환산이 없으면 볼 것이 없어 통과시킨다.
 * 환산 유효일은 저장하는 날(UTC)로 본다 — 품목은 공장에 매이지 않는다.
 */
async function baseSizeDivides(
  prisma: Prisma.TransactionClient,
  itemId: number,
  storageUomId: bigint,
  size: Prisma.Decimal,
  count: number,
): Promise<boolean> {
  const table = await loadStockUomTable(prisma, [BigInt(itemId)], new Date().toISOString().slice(0, 10));
  const converted = toStockUom(table, BigInt(itemId), storageUomId, size);
  if (converted.source === null || converted.stockQty === null) return true;
  const perPackage = converted.stockQty.dividedBy(count).toDecimalPlaces(6);
  return perPackage.times(count).equals(converted.stockQty);
}
