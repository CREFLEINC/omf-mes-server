import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  item,
  item_bu_item_map,
  item_external_code,
  item_uom_conversion,
  Prisma,
} from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import {
  CreateBuItemMapDto,
  CreateExternalCodeDto,
  CreateItemDto,
  CreateUomConversionDto,
  UpdateItemDto,
} from './item.dto';

/** 품목 마스터 — mdm.item + 단위환산·외부코드·사업부간 매핑 */
@Injectable()
export class ItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  // ── 품목 ──────────────────────────────────────────────────────────────

  async create(dto: CreateItemDto, actor?: bigint): Promise<item> {
    await this.validateCodes(dto);
    const baseUom = await this.getUom(dto.baseUomCode);
    this.assertFefoHasShelfLife(dto.fifoPolicyCode, dto.shelfLifeDays);

    orConflict(
      await this.prisma.item.findUnique({ where: { item_code: dto.itemCode } }),
      `이미 존재하는 품목입니다: ${dto.itemCode}`,
    );

    return this.prisma.item.create({
      data: {
        item_code: dto.itemCode,
        item_name: dto.itemName,
        item_type_code: dto.itemTypeCode,
        base_uom_id: baseUom.uom_id,
        lot_control_type_code: dto.lotControlTypeCode,
        serial_control_type_code: dto.serialControlTypeCode ?? 'NONE',
        fifo_policy_code: dto.fifoPolicyCode ?? 'FIFO',
        shelf_life_days: dto.shelfLifeDays ?? null,
        opened_shelf_life_hours: dto.openedShelfLifeHours ?? null,
        inspection_required: dto.inspectionRequired ?? false,
        negative_stock_allowed: dto.negativeStockAllowed ?? false,
        storage_condition_code: dto.storageConditionCode ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: PageQueryDto, itemTypeCode?: string): Promise<PageDto<item>> {
    const extra = itemTypeCode ? { item_type_code: itemTypeCode } : {};
    const where = baseWhere(query, ['item_code', 'item_name'], extra) as Prisma.itemWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.item.findMany({
        where,
        orderBy: { item_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.item.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  /** 단건 조회 — 단위환산·외부코드를 함께 준다. */
  async findOne(itemCode: string) {
    const found = await this.prisma.item.findUnique({
      where: { item_code: itemCode },
      include: {
        uom: true,
        item_uom_conversion: { orderBy: { effective_from: 'desc' } },
        item_external_code: { orderBy: { external_system_code: 'asc' } },
      },
    });
    return orFail(found, `품목(${itemCode})`);
  }

  async update(itemCode: string, dto: UpdateItemDto, actor?: bigint): Promise<item> {
    const found = await this.getItem(itemCode);
    await this.validateCodes(dto);

    const baseUomId = dto.baseUomCode
      ? (await this.getUom(dto.baseUomCode)).uom_id
      : undefined;

    // 저장될 최종 상태로 검사한다 — 한쪽만 보내는 경우가 있다.
    this.assertFefoHasShelfLife(
      dto.fifoPolicyCode ?? found.fifo_policy_code,
      dto.shelfLifeDays ?? found.shelf_life_days ?? undefined,
    );

    return this.prisma.item.update({
      where: { item_id: found.item_id },
      data: {
        item_name: dto.itemName,
        item_type_code: dto.itemTypeCode,
        base_uom_id: baseUomId,
        lot_control_type_code: dto.lotControlTypeCode,
        serial_control_type_code: dto.serialControlTypeCode,
        fifo_policy_code: dto.fifoPolicyCode,
        shelf_life_days: dto.shelfLifeDays,
        opened_shelf_life_hours: dto.openedShelfLifeHours,
        inspection_required: dto.inspectionRequired,
        negative_stock_allowed: dto.negativeStockAllowed,
        storage_condition_code: dto.storageConditionCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /** 비활성화 — 재고가 남아 있으면 막는다. */
  async deactivate(itemCode: string, actor?: bigint): Promise<void> {
    const found = await this.getItem(itemCode);

    const balances = await this.prisma.inventory_balance.count({
      where: { item_id: found.item_id, on_hand_qty: { gt: 0 } },
    });
    if (balances > 0) {
      throw new ConflictException(
        `재고가 남아 있어 비활성화할 수 없습니다: ${itemCode} (잔량 보유 ${balances}건)`,
      );
    }

    await this.prisma.item.update({
      where: { item_id: found.item_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  // ── 단위환산 ──────────────────────────────────────────────────────────

  async addUomConversion(
    itemCode: string,
    dto: CreateUomConversionDto,
    actor?: bigint,
  ): Promise<item_uom_conversion> {
    const found = await this.getItem(itemCode);

    if (dto.fromUomCode === dto.toUomCode) {
      throw new BadRequestException('환산 전·후 단위가 같을 수 없습니다.');
    }
    if (dto.effectiveTo && dto.effectiveTo < dto.effectiveFrom) {
      throw new BadRequestException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }

    const [fromUom, toUom] = await Promise.all([
      this.getUom(dto.fromUomCode),
      this.getUom(dto.toUomCode),
    ]);

    orConflict(
      await this.prisma.item_uom_conversion.findUnique({
        where: {
          item_id_from_uom_id_to_uom_id_effective_from: {
            item_id: found.item_id,
            from_uom_id: fromUom.uom_id,
            to_uom_id: toUom.uom_id,
            effective_from: dto.effectiveFrom,
          },
        },
      }),
      `같은 시작일의 환산 정의가 이미 있습니다: ${dto.fromUomCode}→${dto.toUomCode}`,
    );

    return this.prisma.item_uom_conversion.create({
      data: {
        item_id: found.item_id,
        from_uom_id: fromUom.uom_id,
        to_uom_id: toUom.uom_id,
        conversion_rate: dto.conversionRate,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo ?? null,
        created_by: actor,
      },
    });
  }

  async findUomConversions(itemCode: string): Promise<item_uom_conversion[]> {
    const found = await this.getItem(itemCode);
    return this.prisma.item_uom_conversion.findMany({
      where: { item_id: found.item_id },
      orderBy: [{ effective_from: 'desc' }],
    });
  }

  /** 환산 정의는 이력성이라 비활성 플래그가 없다 — 물리 삭제한다. */
  async removeUomConversion(itemCode: string, conversionId: bigint): Promise<void> {
    const found = await this.getItem(itemCode);
    const row = orFail(
      await this.prisma.item_uom_conversion.findFirst({
        where: { item_uom_conversion_id: conversionId, item_id: found.item_id },
      }),
      `단위환산(${conversionId})`,
    );

    await this.prisma.item_uom_conversion.delete({
      where: { item_uom_conversion_id: row.item_uom_conversion_id },
    });
  }

  // ── 외부 시스템 품목코드 ──────────────────────────────────────────────

  async addExternalCode(
    itemCode: string,
    dto: CreateExternalCodeDto,
    actor?: bigint,
  ): Promise<item_external_code> {
    const found = await this.getItem(itemCode);
    const partnerId = dto.partnerCode ? (await this.getPartner(dto.partnerCode)).partner_id : null;

    // DB의 유니크 인덱스는 COALESCE(partner_id, 0)를 쓴다 — Prisma 모델로 표현되지 않으므로
    // 앱에서 먼저 확인한다. 경합으로 빠져나간 건은 DB가 막고 P2002 → 409로 변환된다.
    orConflict(
      await this.prisma.item_external_code.findFirst({
        where: {
          item_id: found.item_id,
          external_system_code: dto.externalSystemCode,
          partner_id: partnerId,
          external_item_code: dto.externalItemCode,
        },
      }),
      `이미 등록된 외부코드입니다: ${dto.externalSystemCode}.${dto.externalItemCode}`,
    );

    return this.prisma.item_external_code.create({
      data: {
        item_id: found.item_id,
        external_system_code: dto.externalSystemCode,
        external_item_code: dto.externalItemCode,
        partner_id: partnerId,
        created_by: actor,
      },
    });
  }

  async findExternalCodes(itemCode: string): Promise<item_external_code[]> {
    const found = await this.getItem(itemCode);
    return this.prisma.item_external_code.findMany({
      where: { item_id: found.item_id },
      orderBy: [{ external_system_code: 'asc' }],
    });
  }

  async removeExternalCode(itemCode: string, externalCodeId: bigint): Promise<void> {
    const found = await this.getItem(itemCode);
    const row = orFail(
      await this.prisma.item_external_code.findFirst({
        where: { item_external_code_id: externalCodeId, item_id: found.item_id },
      }),
      `외부코드(${externalCodeId})`,
    );

    await this.prisma.item_external_code.delete({
      where: { item_external_code_id: row.item_external_code_id },
    });
  }

  // ── 사업부 간 품목 매핑 ───────────────────────────────────────────────

  async addBuItemMap(
    itemCode: string,
    dto: CreateBuItemMapDto,
    actor?: bigint,
  ): Promise<item_bu_item_map> {
    const fromItem = await this.getItem(itemCode);

    if (dto.fromBusinessUnitCode === dto.toBusinessUnitCode) {
      throw new BadRequestException('출발·도착 사업부가 같을 수 없습니다.');
    }
    if (dto.effectiveTo && dto.effectiveTo < dto.effectiveFrom) {
      throw new BadRequestException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }

    const [fromBu, toBu, toItem] = await Promise.all([
      this.getBusinessUnit(dto.fromBusinessUnitCode),
      this.getBusinessUnit(dto.toBusinessUnitCode),
      this.getItem(dto.toItemCode),
    ]);

    orConflict(
      await this.prisma.item_bu_item_map.findUnique({
        where: {
          from_business_unit_id_from_item_id_to_business_unit_id_effective_from: {
            from_business_unit_id: fromBu.business_unit_id,
            from_item_id: fromItem.item_id,
            to_business_unit_id: toBu.business_unit_id,
            effective_from: dto.effectiveFrom,
          },
        },
      }),
      `같은 시작일의 사업부 간 매핑이 이미 있습니다: ${dto.fromBusinessUnitCode}→${dto.toBusinessUnitCode}`,
    );

    return this.prisma.item_bu_item_map.create({
      data: {
        from_business_unit_id: fromBu.business_unit_id,
        from_item_id: fromItem.item_id,
        to_business_unit_id: toBu.business_unit_id,
        to_item_id: toItem.item_id,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo ?? null,
        created_by: actor,
      },
    });
  }

  async findBuItemMaps(itemCode: string): Promise<item_bu_item_map[]> {
    const found = await this.getItem(itemCode);
    return this.prisma.item_bu_item_map.findMany({
      where: { from_item_id: found.item_id },
      orderBy: [{ effective_from: 'desc' }],
    });
  }

  async removeBuItemMap(itemCode: string, mapId: bigint): Promise<void> {
    const found = await this.getItem(itemCode);
    const row = orFail(
      await this.prisma.item_bu_item_map.findFirst({
        where: { item_bu_item_map_id: mapId, from_item_id: found.item_id },
      }),
      `사업부 간 매핑(${mapId})`,
    );

    await this.prisma.item_bu_item_map.delete({
      where: { item_bu_item_map_id: row.item_bu_item_map_id },
    });
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private async validateCodes(dto: CreateItemDto | UpdateItemDto): Promise<void> {
    await this.codes.assertAllValid([
      ['ITEM_TYPE', dto.itemTypeCode],
      ['LOT_CONTROL_TYPE', dto.lotControlTypeCode],
      ['SERIAL_CONTROL_TYPE', dto.serialControlTypeCode],
      ['FIFO_POLICY', dto.fifoPolicyCode],
      ['STORAGE_CONDITION', dto.storageConditionCode],
    ]);
  }

  /**
   * FEFO(선입선출이 아닌 '유효기간 임박 우선')는 유효기간이 있어야 성립한다.
   * 근거: QA #28 — "유효기한 관리 플래그+선출 정책(관리 품목=FEFO, 나머지=FIFO)".
   * DDL에는 이 제약이 없어 앱에서만 막는다.
   */
  private assertFefoHasShelfLife(fifoPolicyCode?: string, shelfLifeDays?: number | null): void {
    if (fifoPolicyCode === 'FEFO' && (shelfLifeDays === undefined || shelfLifeDays === null)) {
      throw new BadRequestException(
        'FEFO 품목은 유효기간(shelfLifeDays)이 필요합니다. 유효기간 미관리 품목은 FIFO를 쓰십시오.',
      );
    }
  }

  private async getItem(itemCode: string): Promise<item> {
    return orFail(
      await this.prisma.item.findUnique({ where: { item_code: itemCode } }),
      `품목(${itemCode})`,
    );
  }

  private async getUom(uomCode: string) {
    return orFail(
      await this.prisma.uom.findUnique({ where: { uom_code: uomCode } }),
      `단위(${uomCode})`,
    );
  }

  private async getPartner(partnerCode: string) {
    return orFail(
      await this.prisma.partner.findUnique({ where: { partner_code: partnerCode } }),
      `거래처(${partnerCode})`,
    );
  }

  private async getBusinessUnit(businessUnitCode: string) {
    const rows = await this.prisma.business_unit.findMany({
      where: { business_unit_code: businessUnitCode },
      take: 2,
    });
    if (rows.length === 0) orFail(null, `사업부(${businessUnitCode})`);
    if (rows.length > 1) {
      throw new ConflictException(
        `사업부코드 ${businessUnitCode}가 여러 법인에 존재합니다. 법인을 함께 지정해야 합니다.`,
      );
    }
    return rows[0];
  }
}
