import { Injectable, NotFoundException } from '@nestjs/common';

import { productionLotLabelQty } from '../../app/document-issue/production-lot-label-qty';
import type { TerminalContext } from '../../auth/terminal-context';
import { ERROR_CODE, field, one } from '../../common/errors';
import { productionRootOf } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { loadSplitLocations, loadSplitLotFacts, locationBlocked, lotBlocked } from './product-lot-split-rules';
import { ProductLotSplitLookup } from './product-lot-split-view';

@Injectable()
export class ProductLotSplitQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** 스캔 조회(R-14) — 분리 요청과 같은 규칙으로 LOT·위치별 막힌 이유를 먼저 낸다. 불량 창고 몫은 싣지 않는다. */
  async lookup(lotNo: string | undefined, terminal: TerminalContext): Promise<ProductLotSplitLookup> {
    if (lotNo === undefined || lotNo.trim() === '') throw one(field('lotNo', ERROR_CODE.REQUIRED, 'LOT 번호가 필요합니다.'));
    const lot = await loadSplitLotFacts(this.prisma, terminal.plantId, { lotNo: lotNo.trim() });
    if (lot === undefined) throw new NotFoundException('이 공장의 LOT 이 아닙니다.');
    const [locations, labelQty, roots] = await Promise.all([
      loadSplitLocations(this.prisma, terminal.plantId, lot.lot_id),
      productionLotLabelQty(this.prisma, [lot.lot_id]),
      productionRootOf(this.prisma, [lot.lot_id]),
    ]);
    const root = roots.get(lot.lot_id) ?? null;
    const workOrder = root === null ? null
      : await this.prisma.work_order.findUnique({ where: { work_order_id: root.workOrderId }, select: { work_order_no: true } });
    const blocked = lotBlocked(lot);
    return {
      lot: {
        lotId: Number(lot.lot_id), lotNo: lot.lot_no, itemCode: lot.item_code, itemName: lot.item_name, uomCode: lot.uom_code,
        statusCode: lot.status_code, workOrderNo: workOrder?.work_order_no ?? null, labelQty: Number(labelQty.get(lot.lot_id) ?? 0),
      },
      blocked,
      locations: locations.filter((row) => !row.is_defect).map((row) => {
        const where = locationBlocked(row);
        return {
          locationId: Number(row.location_id), locationCode: row.location_code, warehouseCode: row.warehouse_code,
          onHandQty: Number(row.on_hand), selectable: blocked === null && where === null,
          blocked: where === null ? null : { code: where.code },
          systemRoleCode: row.system_role_code,
        };
      }),
    };
  }
}
