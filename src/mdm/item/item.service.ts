import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
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
  /** ERP 규격(SPEC)·품목그룹(ITEM_GROUP_CD) — 계약 밖 칸(장부 P-75). MES 에서 만든 품목은 null. */
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
  nameKo?: string | null;
  nameVi?: string | null;
}

export interface ItemQuery extends ReferenceQuery {
  itemTypeCode?: string;
  hasRouting?: boolean;
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
    const where = referenceWhere(query, { code: 'item_code', name: 'item_name' }, {
      ...(query.itemTypeCode === undefined ? {} : { item_type_code: query.itemTypeCode }),
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

    const updated = await this.prisma.item.updateMany({
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
        ...optional('default_production_lot_size', lotSizeOf(input)),
        ...optional('name_ko', input.nameKo),
        ...optional('name_vi', input.nameVi),
        version_no: { increment: 1 },
      },
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
