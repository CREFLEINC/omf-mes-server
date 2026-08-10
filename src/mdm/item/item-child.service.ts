import { Injectable, NotFoundException } from '@nestjs/common';

import { ContractBadRequest } from '../../common/errors/contract-error';
import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BuItemMapRowDto,
  ExternalCodeRowDto,
  UomConversionRowDto,
} from './item-child.dto';
import { ItemChildValidator } from './item-child.validator';
import { toBuItemMap, toExternalCode, toUomConversion } from './item-child.mapper';

type Schemas = components['schemas'];

/**
 * 부속 3종은 **최종 상태를 통째로 받아** 한 트랜잭션으로 지우고 넣는다(공유계약 B-6).
 *
 * 개별 부여·회수 API 가 없으므로 「보낸 것이 전부」다 — 안 보낸 행은 사라진다.
 *
 * **낙관적 잠금이 없다.** 이 테이블들에는 `version_no` 컬럼이 없고 계약도 자식 `PUT` 에
 * `If-Match` 를 두지 않았다. 두 사람이 같은 품목의 부속을 동시에 고치면 나중 사람이
 * 앞사람 것을 조용히 덮어쓴다 — 계약 소유자에게 되돌릴 미결이다(계획서).
 */
@Injectable()
export class ItemChildService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: ItemChildValidator,
  ) {}

  async findUomConversions(itemId: bigint): Promise<Schemas['ItemUomConversionListResponse']> {
    await this.assertItem(itemId);

    const rows = await this.prisma.item_uom_conversion.findMany({
      where: { item_id: itemId },
      // uq_item_uom_conversion 을 따라 정렬해 페이지 없이도 차례가 고정된다.
      orderBy: [{ from_uom_id: 'asc' }, { to_uom_id: 'asc' }, { effective_from: 'asc' }],
    });

    return { items: rows.map(toUomConversion) };
  }

  async replaceUomConversions(
    itemId: bigint,
    rows: UomConversionRowDto[],
    actorId: bigint,
  ): Promise<Schemas['ItemUomConversionListResponse']> {
    await this.assertItem(itemId);

    const errors = await this.validator.validateUomConversions(rows);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    await this.prisma.$transaction([
      this.prisma.item_uom_conversion.deleteMany({ where: { item_id: itemId } }),
      this.prisma.item_uom_conversion.createMany({
        data: rows.map((row) => ({
          item_id: itemId,
          from_uom_id: BigInt(row.fromUomId),
          to_uom_id: BigInt(row.toUomId),
          conversion_rate: row.conversionRate,
          effective_from: new Date(row.effectiveFrom),
          effective_to: row.effectiveTo ? new Date(row.effectiveTo) : null,
          created_by: actorId,
        })),
      }),
    ]);

    return this.findUomConversions(itemId);
  }

  async findExternalCodes(itemId: bigint): Promise<Schemas['ItemExternalCodeListResponse']> {
    await this.assertItem(itemId);

    const rows = await this.prisma.item_external_code.findMany({
      where: { item_id: itemId },
      orderBy: [
        { external_system_code: 'asc' },
        { partner_id: { sort: 'asc', nulls: 'first' } },
        { external_item_code: 'asc' },
      ],
    });

    return { items: rows.map(toExternalCode) };
  }

  async replaceExternalCodes(
    itemId: bigint,
    rows: ExternalCodeRowDto[],
    actorId: bigint,
  ): Promise<Schemas['ItemExternalCodeListResponse']> {
    await this.assertItem(itemId);

    const errors = await this.validator.validateExternalCodes(rows);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    await this.prisma.$transaction([
      this.prisma.item_external_code.deleteMany({ where: { item_id: itemId } }),
      this.prisma.item_external_code.createMany({
        data: rows.map((row) => ({
          item_id: itemId,
          external_system_code: row.externalSystemCode,
          partner_id: row.partnerId ? BigInt(row.partnerId) : null,
          external_item_code: row.externalItemCode,
          created_by: actorId,
        })),
      }),
    ]);

    return this.findExternalCodes(itemId);
  }

  async findBuItemMaps(itemId: bigint): Promise<Schemas['ItemBuItemMapListResponse']> {
    await this.assertItem(itemId);

    // 경로의 품목을 fromItemId 로 고정한 매핑만 낸다 — 반대 방향은 그 품목의 목록이다.
    const rows = await this.prisma.item_bu_item_map.findMany({
      where: { from_item_id: itemId },
      orderBy: [
        { from_business_unit_id: 'asc' },
        { to_business_unit_id: 'asc' },
        { effective_from: 'asc' },
      ],
    });

    return { items: rows.map(toBuItemMap) };
  }

  async replaceBuItemMaps(
    itemId: bigint,
    rows: BuItemMapRowDto[],
    actorId: bigint,
  ): Promise<Schemas['ItemBuItemMapListResponse']> {
    await this.assertItem(itemId);

    const errors = await this.validator.validateBuItemMaps(rows);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    await this.prisma.$transaction([
      this.prisma.item_bu_item_map.deleteMany({ where: { from_item_id: itemId } }),
      this.prisma.item_bu_item_map.createMany({
        data: rows.map((row) => ({
          from_business_unit_id: BigInt(row.fromBusinessUnitId),
          from_item_id: itemId,
          to_business_unit_id: BigInt(row.toBusinessUnitId),
          to_item_id: BigInt(row.toItemId),
          effective_from: new Date(row.effectiveFrom),
          effective_to: row.effectiveTo ? new Date(row.effectiveTo) : null,
          created_by: actorId,
        })),
      }),
    ]);

    return this.findBuItemMaps(itemId);
  }

  /** 없는 품목의 부속을 다루면 404 다 — 빈 목록을 주면 화면이 품목이 있는 줄 안다. */
  private async assertItem(itemId: bigint): Promise<void> {
    const found = await this.prisma.item.findUnique({
      where: { item_id: itemId },
      select: { item_id: true },
    });
    if (!found) throw new NotFoundException(`품목(${itemId})을 찾을 수 없습니다.`);
  }
}
