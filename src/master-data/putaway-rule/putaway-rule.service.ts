import { Injectable } from '@nestjs/common';
import { item, location, Prisma, putaway_rule, uom, warehouse } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  baseWhere,
  createStamp,
  exactlyOne,
  orConflict,
  orFail,
  updateStamp,
} from '../common/master-crud';
import {
  CreatePutawayRuleDto,
  PutawayRuleQueryDto,
  UpdatePutawayRuleDto,
} from './putaway-rule.dto';

@Injectable()
export class PutawayRuleService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePutawayRuleDto, actor?: bigint): Promise<putaway_rule> {
    const [item, warehouse, uom] = await Promise.all([
      this.getItem(dto.itemCode),
      this.getWarehouse(dto.warehouseCode),
      this.getUom(dto.uomCode),
    ]);

    const location = dto.locationCode
      ? await this.getLocation(warehouse, dto.locationCode)
      : null;

    // uq_putaway_rule은 COALESCE(location_id,0)을 써서 Prisma 모델로 표현되지 않는다.
    orConflict(
      await this.prisma.putaway_rule.findFirst({
        where: {
          item_id: item.item_id,
          warehouse_id: warehouse.warehouse_id,
          location_id: location?.location_id ?? null,
        },
      }),
      `같은 품목·창고·로케이션의 적치규칙이 이미 있습니다: ${dto.itemCode}`,
    );

    return this.prisma.putaway_rule.create({
      data: {
        item_id: item.item_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: location?.location_id ?? null,
        capacity_qty: dto.capacityQty,
        uom_id: uom.uom_id,
        priority_no: dto.priorityNo ?? 100,
        remarks: dto.remarks ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: PutawayRuleQueryDto): Promise<PageDto<putaway_rule>> {
    const extra: Prisma.putaway_ruleWhereInput = {};
    if (query.itemCode) extra.item = { item_code: query.itemCode };
    if (query.warehouseCode) extra.warehouse = { warehouse_code: query.warehouseCode };

    const where = baseWhere(query, [], extra) as Prisma.putaway_ruleWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.putaway_rule.findMany({
        where,
        include: {
          item: { select: { item_code: true, item_name: true } },
          warehouse: { select: { warehouse_code: true } },
          location: { select: { location_code: true } },
          uom: { select: { uom_code: true } },
        },
        orderBy: [{ priority_no: 'asc' }, { putaway_rule_id: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.putaway_rule.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(ruleId: bigint) {
    const found = await this.prisma.putaway_rule.findUnique({
      where: { putaway_rule_id: ruleId },
      include: {
        item: { select: { item_code: true, item_name: true } },
        warehouse: { select: { warehouse_code: true } },
        location: { select: { location_code: true } },
        uom: { select: { uom_code: true } },
      },
    });
    return orFail(found, `적치규칙(${ruleId})`);
  }

  async update(
    ruleId: bigint,
    dto: UpdatePutawayRuleDto,
    actor?: bigint,
  ): Promise<putaway_rule> {
    const found = await this.getRule(ruleId);
    const uomId = dto.uomCode ? (await this.getUom(dto.uomCode)).uom_id : undefined;

    return this.prisma.putaway_rule.update({
      where: { putaway_rule_id: found.putaway_rule_id },
      data: {
        capacity_qty: dto.capacityQty,
        uom_id: uomId,
        priority_no: dto.priorityNo,
        remarks: dto.remarks,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(ruleId: bigint, actor?: bigint): Promise<void> {
    const found = await this.getRule(ruleId);

    await this.prisma.putaway_rule.update({
      where: { putaway_rule_id: found.putaway_rule_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  private async getRule(ruleId: bigint): Promise<putaway_rule> {
    return orFail(
      await this.prisma.putaway_rule.findUnique({ where: { putaway_rule_id: ruleId } }),
      `적치규칙(${ruleId})`,
    );
  }

  private async getItem(itemCode: string): Promise<item> {
    return orFail(
      await this.prisma.item.findUnique({ where: { item_code: itemCode } }),
      `품목(${itemCode})`,
    );
  }

  /** 창고코드는 (공장, 코드)로만 유일하다 — 여러 공장에 같은 코드가 있으면 거부한다. */
  private async getWarehouse(warehouseCode: string): Promise<warehouse> {
    const rows = await this.prisma.warehouse.findMany({
      where: { warehouse_code: warehouseCode },
      take: 2,
    });
    return exactlyOne(rows, '창고', warehouseCode);
  }

  /** 로케이션은 소속 창고 안에서만 유일하다 — 다른 창고의 로케이션을 붙이면 적치가 엉뚱한 곳으로 간다. */
  private async getLocation(parent: warehouse, locationCode: string): Promise<location> {
    return orFail(
      await this.prisma.location.findUnique({
        where: {
          warehouse_id_location_code: {
            warehouse_id: parent.warehouse_id,
            location_code: locationCode,
          },
        },
      }),
      `로케이션(${parent.warehouse_code}/${locationCode})`,
    );
  }

  private async getUom(uomCode: string): Promise<uom> {
    return orFail(
      await this.prisma.uom.findUnique({ where: { uom_code: uomCode } }),
      `단위(${uomCode})`,
    );
  }
}
