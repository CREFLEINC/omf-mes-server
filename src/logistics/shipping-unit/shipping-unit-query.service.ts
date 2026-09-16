import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ShippingUnitBoxView,
  ShippingUnitDetailView,
  ShippingUnitItemTotalView,
  ShippingUnitRow,
  ShippingUnitView,
  qtyNumber,
  shippingUnitView,
} from './shipping-unit-view';

export interface ShippingUnitFilters {
  shipmentId?: number;
  statusCode?: string;
  q?: string;
  page?: number;
  size?: number;
}

/** 고객·납품처까지 한 번에 끌어 온다 — 목록도 상세도 그 두 값을 싣는다. */
const UNIT_INCLUDE = {
  shipment: {
    select: {
      shipment_no: true,
      shipment_request: {
        select: {
          partner_shipment_request_customer_idTopartner: {
            select: { partner_id: true, partner_code: true, partner_name: true },
          },
          partner_shipment_request_ship_to_partner_idTopartner: {
            select: { partner_id: true, partner_code: true, partner_name: true },
          },
        },
      },
    },
  },
} satisfies Prisma.shipping_unitInclude;

@Injectable()
export class ShippingUnitQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    filters: ShippingUnitFilters,
    terminalPlantId?: bigint,
  ): Promise<PagedResponse<ShippingUnitView>> {
    const page = pageRequest({ page: filters.page, size: filters.size });
    const where: Prisma.shipping_unitWhereInput = {
      ...(filters.shipmentId === undefined ? {} : { shipment_id: BigInt(filters.shipmentId) }),
      ...(filters.statusCode === undefined ? {} : { status_code: filters.statusCode }),
      // 출하 단위 번호 부분 일치 — 화면이 번호 조각으로 찾는다.
      ...(filters.q === undefined ? {} : { shipping_unit_no: { contains: filters.q, mode: 'insensitive' as const } }),
      // ⛔ 단말이면 그 단말의 공장으로 좁힌다 — 단말은 자기 창고를 모르고, 좁히지 않으면
      //   남의 공장 출하 단위가 목록에 샌다.
      ...(terminalPlantId === undefined ? {} : { shipment: { warehouse: { plant_id: terminalPlantId } } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.shipping_unit.findMany({
        where,
        include: { ...UNIT_INCLUDE, _count: { select: { shipping_unit_handling_unit: true } } },
        orderBy: { shipping_unit_id: 'desc' },
        skip: page.skip,
        take: page.size,
      }),
      this.prisma.shipping_unit.count({ where }),
    ]);

    return pagedResponse(
      rows.map((row) => shippingUnitView(row as unknown as ShippingUnitRow, row._count.shipping_unit_handling_unit)),
      total,
      page,
    );
  }

  async get(shippingUnitId: number, terminalPlantId?: bigint): Promise<ShippingUnitDetailView> {
    const unit = await this.prisma.shipping_unit.findFirst({
      where: {
        shipping_unit_id: BigInt(shippingUnitId),
        ...(terminalPlantId === undefined ? {} : { shipment: { warehouse: { plant_id: terminalPlantId } } }),
      },
      include: UNIT_INCLUDE,
    });
    if (unit === null) throw new NotFoundException('없는 출하 단위입니다.');

    const boxes = await this.boxesOf(BigInt(shippingUnitId));
    return {
      ...shippingUnitView(unit as unknown as ShippingUnitRow, boxes.length),
      boxes,
      itemTotals: itemTotals(boxes),
    };
  }

  /** 상자와 그 내용물. 스캔 순서(`seq`)로 읽는다 — 납품 라벨 본문이 이 순서를 쓴다. */
  private async boxesOf(shippingUnitId: bigint): Promise<ShippingUnitBoxView[]> {
    const links = await this.prisma.shipping_unit_handling_unit.findMany({
      where: { shipping_unit_id: shippingUnitId },
      orderBy: { seq: 'asc' },
      include: {
        handling_unit: {
          select: {
            handling_unit_id: true,
            handling_unit_no: true,
            handling_unit_content: {
              select: {
                qty: true,
                item: { select: { item_id: true, item_code: true, item_name: true } },
                lot: { select: { lot_id: true, lot_no: true } },
                uom: { select: { uom_id: true, uom_code: true } },
              },
            },
          },
        },
      },
    });

    return links.map((link) => ({
      handlingUnitId: Number(link.handling_unit.handling_unit_id),
      handlingUnitNo: link.handling_unit.handling_unit_no,
      seq: link.seq,
      contents: link.handling_unit.handling_unit_content.map((content) => ({
        itemId: Number(content.item.item_id),
        itemCode: content.item.item_code,
        itemName: content.item.item_name,
        lotId: Number(content.lot.lot_id),
        lotNo: content.lot.lot_no,
        qty: qtyNumber(content.qty),
        uomId: Number(content.uom.uom_id),
        uomCode: content.uom.uom_code,
      })),
    }));
  }
}

/**
 * 납품 라벨 본문 — 품목별 합계.
 *
 * ⛔ 묶음 키는 **(품목, 단위)** 다. 같은 품목이라도 단위가 다르면 두 행으로 나온다 — 단위를
 * 섞어 더하면 「480」이 무엇의 480 인지 알 수 없는 수가 된다.
 * ⚠ 정렬은 품목 코드 오름차순이다. 스캔 순서로 두면 같은 라벨을 두 번 뽑을 때 줄이 뒤바뀐다.
 */
export function itemTotals(boxes: ShippingUnitBoxView[]): ShippingUnitItemTotalView[] {
  const byKey = new Map<string, ShippingUnitItemTotalView>();
  for (const box of boxes) {
    for (const content of box.contents) {
      const key = `${content.itemId}:${content.uomId}`;
      const found = byKey.get(key);
      if (found === undefined) {
        byKey.set(key, {
          itemId: content.itemId,
          itemCode: content.itemCode,
          itemName: content.itemName,
          qty: content.qty,
          uomId: content.uomId,
          uomCode: content.uomCode,
        });
      } else {
        found.qty += content.qty;
      }
    }
  }
  return [...byKey.values()].sort((left, right) => left.itemCode.localeCompare(right.itemCode));
}
