import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertCodeValues } from '../code-reference';
import { optional } from '../column';
import { Editability } from '../editability';
import { ReferenceQuery, referencePage, referenceWhere } from '../reference/reference.query';

/** 계약 `Item` 과 동형. 위(ERP 원본)와 아래(MES 확장)를 화면이 나눠 그린다. */
interface ItemView {
  itemId: number;
  itemCode: string;
  itemName: string;
  nameKo: string | null;
  nameVi: string | null;
  itemTypeCode: string;
  baseUomId: number;
  lotControlTypeCode: string;
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
  defaultProductionLotSize: number | null;
}

export interface ItemUpdate {
  lotControlTypeCode: string;
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
  defaultProductionLotSize?: number | null;
  nameKo?: string | null;
  nameVi?: string | null;
}

export interface ItemQuery extends ReferenceQuery {
  itemTypeCode?: string;
  hasRouting?: boolean;
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
        lot_control_type_code: input.lotControlTypeCode,
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
        ...optional('default_production_lot_size', input.defaultProductionLotSize),
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
        field: 'lotControlTypeCode',
        value: input.lotControlTypeCode,
        groupCode: 'LOT_CONTROL_TYPE',
      },
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
  return {
    itemId: Number(row.item_id),
    itemCode: row.item_code,
    itemName: row.item_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    itemTypeCode: row.item_type_code,
    baseUomId: Number(row.base_uom_id),
    lotControlTypeCode: row.lot_control_type_code,
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
    defaultProductionLotSize:
      row.default_production_lot_size === null ? null : Number(row.default_production_lot_size),
  };
}
