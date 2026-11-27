import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { productionLotLabelQty } from '../../app/document-issue/production-lot-label-qty';
import type { TerminalContext } from '../../auth/terminal-context';
import { ERROR_CODE, field, one } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { productionRootOf } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { loadSplitLocations, loadSplitLotFacts, locationBlocked, lotBlocked } from './product-lot-split-rules';
import { PrintState, ProductLotSplitLookup, ProductLotSplitView } from './product-lot-split-view';

type Db = Prisma.TransactionClient | PrismaService;

export interface ProductLotSplitListQuery {
  status?: string;
  lotNo?: string;
  page?: number;
  size?: number;
}

export type ProductLotSplitPage = PagedResponse<ProductLotSplitView> & { unconfirmedCount: number };

const SPLIT_INCLUDE = {
  parent_lot: { select: { lot_no: true, item: { select: { item_id: true, item_code: true, item_name: true } }, uom: { select: { uom_code: true } } } },
  child_lot: { select: { lot_no: true } },
  location: { select: { location_code: true } },
} satisfies Prisma.product_lot_splitInclude;

type SplitRow = Prisma.product_lot_splitGetPayload<{ include: typeof SPLIT_INCLUDE }>;

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

  /**
   * 목록·찾기 — 단말 공장의 분리만. `lotNo` 를 주면(PDA 첫 스캔) 많아야 한 건이다: 그 LOT 의 확인 대기 분리, 없으면
   * 가장 최근 확인된 분리(`status` 무시), 둘 다 없으면 빈 목록(research R-3).
   */
  async list(query: ProductLotSplitListQuery, terminal: TerminalContext): Promise<ProductLotSplitPage> {
    const request = pageRequest({ page: query.page, size: query.size });
    const plant = { plant_id: terminal.plantId };
    const unconfirmedCount = await this.prisma.product_lot_split.count({ where: { ...plant, confirmed_at: null } });
    const lotNo = query.lotNo?.trim();
    if (lotNo !== undefined && lotNo !== '') {
      const ofLot = { ...plant, OR: [{ parent_lot: { lot_no: lotNo } }, { child_lot: { lot_no: lotNo } }] };
      const row = await this.prisma.product_lot_split.findFirst({ where: { ...ofLot, confirmed_at: null }, include: SPLIT_INCLUDE })
        ?? await this.prisma.product_lot_split.findFirst({
          where: { ...ofLot, confirmed_at: { not: null } }, orderBy: [{ confirmed_at: 'desc' }, { product_lot_split_id: 'desc' }], include: SPLIT_INCLUDE,
        });
      const items = row === null ? [] : await splitViews(this.prisma, [row]);
      return { ...pagedResponse(items, items.length, request), unconfirmedCount };
    }
    const status = query.status ?? 'UNCONFIRMED';
    if (!['UNCONFIRMED', 'CONFIRMED', 'ALL'].includes(status)) throw one(field('status', ERROR_CODE.INVALID, '상태 값이 올바르지 않습니다.'));
    const where: Prisma.product_lot_splitWhereInput = status === 'UNCONFIRMED' ? { ...plant, confirmed_at: null }
      : status === 'CONFIRMED' ? { ...plant, confirmed_at: { not: null } } : plant;
    const order: Prisma.SortOrder = status === 'UNCONFIRMED' ? 'asc' : 'desc';
    const [total, rows] = await Promise.all([
      this.prisma.product_lot_split.count({ where }),
      this.prisma.product_lot_split.findMany({
        where, include: SPLIT_INCLUDE, orderBy: [{ split_at: order }, { product_lot_split_id: order }], skip: request.skip, take: request.take,
      }),
    ]);
    return { ...pagedResponse(await splitViews(this.prisma, rows), total, request), unconfirmedCount };
  }

  /** 분리 하나의 보기 — 확인 응답이 쓴다. */
  async view(db: Db, splitId: bigint): Promise<ProductLotSplitView> {
    const row = await db.product_lot_split.findUniqueOrThrow({ where: { product_lot_split_id: splitId }, include: SPLIT_INCLUDE });
    const [view] = await splitViews(db, [row]);
    return view;
  }
}

async function splitViews(db: Db, rows: SplitRow[]): Promise<ProductLotSplitView[]> {
  const lotIds = rows.flatMap((row) => [row.parent_lot_id, row.child_lot_id]);
  const [qty, prints] = await Promise.all([productionLotLabelQty(db, lotIds), lastPrints(db, lotIds)]);
  const ref = (lotId: bigint, lotNo: string) => ({ lotId: Number(lotId), lotNo, qty: Number(qty.get(lotId) ?? 0) });
  return rows.map((row) => ({
    productLotSplitId: Number(row.product_lot_split_id),
    status: row.confirmed_at === null ? 'UNCONFIRMED' : 'CONFIRMED',
    parentLot: ref(row.parent_lot_id, row.parent_lot.lot_no),
    childLot: ref(row.child_lot_id, row.child_lot.lot_no),
    item: {
      itemId: Number(row.parent_lot.item.item_id), itemCode: row.parent_lot.item.item_code,
      itemName: row.parent_lot.item.item_name, uomCode: row.parent_lot.uom.uom_code,
    },
    location: { locationId: Number(row.location_id), locationCode: row.location.location_code },
    splitAt: row.split_at.toISOString(),
    splitWorkerNo: row.split_worker_no,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    confirmedWorkerNo: row.confirmed_worker_no,
    lastPrint: { parent: prints.get(row.parent_lot_id) ?? 'NONE', child: prints.get(row.child_lot_id) ?? 'NONE' },
  }));
}

/** LOT 마다 가장 최근 생산 LOT 라벨 발행의 인쇄 결과 — 보고 전(PENDING)은 NONE. */
async function lastPrints(db: Db, lotIds: bigint[]): Promise<Map<bigint, PrintState>> {
  if (lotIds.length === 0) return new Map();
  const rows = await db.document_issue_log.findMany({
    where: { document_type_code: 'PRODUCTION_LOT_LABEL', lot_id: { in: lotIds } },
    orderBy: [{ lot_id: 'asc' }, { issue_seq: 'desc' }],
    distinct: ['lot_id'],
    select: { lot_id: true, print_outcome_code: true },
  });
  const state = (code: string | null): PrintState => (code === 'SUCCEEDED' ? 'PRINTED' : code === 'FAILED' ? 'FAILED' : 'NONE');
  return new Map(rows.map((row) => [row.lot_id as bigint, state(row.print_outcome_code)]));
}
