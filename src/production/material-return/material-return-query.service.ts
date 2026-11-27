import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { unprintedSplitLotIds } from '../../logistics/split-material-lot/split-material-lot-query.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FinalCloseProbe } from './final-close';
import {
  MATERIAL_RETURN_LINE_INCLUDE,
  MaterialReturnView,
  materialReturnView,
} from './material-return-view';
import { RETURN_MESSAGES } from './material-return.constants';
import { loadReturnLots } from './return-lots';

/** 계약 `MaterialReturnLotLookup`(§1). */
export interface MaterialReturnLotLookup {
  lotId: number;
  lotNo: string;
  item: { itemId: number; itemCode: string; itemName: string };
  uom: { uomId: number; uomCode: string; decimalScale: number };
  returnableQty: number;
  workOrder: { workOrderId: number; workOrderNo: string; finalized: boolean };
  issueWarehouse: { warehouseId: number; warehouseCode: string; warehouseName: string };
  labelUnprinted: boolean;
}

/** 계약 질의 6 전건 — 필수는 하나도 없다. 형·기본값은 `@Contract` 가드가 이미 맞춰 둔다. */
export interface MaterialReturnListQuery {
  workOrderId?: unknown;
  statusCode?: string;
  requestedFrom?: string;
  requestedTo?: string;
  page?: number;
  size?: number;
}

/** 정렬 키가 계약에 **없다** ⇒ 서버가 고정한다(§5-1 과 같은 근거 · 동률은 PK 로 닫는다). */
export const MATERIAL_RETURN_ORDER_BY: Prisma.material_returnOrderByWithRelationInput[] = [
  { requested_at: 'desc' },
  { material_return_id: 'desc' },
];

/** 반납 조회 — 목록·단건(I-10 PR ① · ETag·403 미선언)과 반납 입고 LOT 조회(피처 019 §1). */
@Injectable()
export class MaterialReturnQueryService {
  constructor(private readonly prisma: PrismaService, private readonly finalClose: FinalCloseProbe) {}

  /**
   * LOT 스캔(§1) — 반납할 수 있으면 품목·반납 가능 양·귀속될 W/O·출고 생산창고. `plantId` 가 있으면(단말) 그 공장 LOT 만 찾는다.
   * 없으면 404, 반납 대상이 아니면 400 NOT_RETURNABLE, 남은 양이 없으면 400 NOTHING_TO_RETURN — 화면은 문구를 그대로 보인다.
   */
  async lotLookup(lotNo: string, plantId: bigint | null): Promise<MaterialReturnLotLookup> {
    const lot = await this.prisma.lot.findFirst({
      where: { lot_no: lotNo, ...(plantId === null ? {} : { plant_id: plantId }) }, select: { lot_id: true },
    });
    if (lot === null) throw new NotFoundException('LOT 을 찾을 수 없습니다.');
    const facts = (await loadReturnLots(this.prisma, this.finalClose, [lot.lot_id], plantId)).get(lot.lot_id);
    if (facts === undefined || facts === 'NOT_FOUND') throw new NotFoundException('LOT 을 찾을 수 없습니다.');
    if (typeof facts === 'string') throw new ContractException(HttpStatus.BAD_REQUEST, [field('lotNo', facts, RETURN_MESSAGES[facts])]);
    const [warehouse, unprinted] = await Promise.all([
      this.prisma.warehouse.findUniqueOrThrow({
        where: { warehouse_id: facts.issue.sourceWarehouseId }, select: { warehouse_code: true, warehouse_name: true },
      }),
      unprintedSplitLotIds(this.prisma, [facts.lotId]),
    ]);
    return {
      lotId: Number(facts.lotId), lotNo: facts.lotNo,
      item: { itemId: Number(facts.itemId), itemCode: facts.itemCode, itemName: facts.itemName },
      uom: { uomId: Number(facts.uomId), uomCode: facts.uomCode, decimalScale: facts.decimalScale },
      returnableQty: facts.returnable.toNumber(),
      workOrder: { workOrderId: Number(facts.issue.workOrderId), workOrderNo: facts.issue.workOrderNo, finalized: facts.finalized },
      issueWarehouse: { warehouseId: Number(facts.issue.sourceWarehouseId), warehouseCode: warehouse.warehouse_code, warehouseName: warehouse.warehouse_name },
      labelUnprinted: unprinted.has(facts.lotId),
    };
  }

  async list(query: MaterialReturnListQuery): Promise<PagedResponse<MaterialReturnView>> {
    const page = pageRequest(query);
    // 반개구간 — From 이상 · To 미만(공유계약 L-3).
    const requestedAt = {
      ...(query.requestedFrom === undefined ? {} : { gte: new Date(query.requestedFrom) }),
      ...(query.requestedTo === undefined ? {} : { lt: new Date(query.requestedTo) }),
    };
    const where: Prisma.material_returnWhereInput = {
      ...filter('work_order_id', numeric('workOrderId', query.workOrderId)),
      // 문자 그대로 건다 — `x-no-code-key` 라 대조할 값 목록이 아예 없다(I-10 §5-3).
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
      ...(Object.keys(requestedAt).length === 0 ? {} : { requested_at: requestedAt }),
    };

    const [rows, total] = await Promise.all([
      // ⭐ 목록에도 라인을 싣는다 — 목록·상세가 같은 `MaterialReturn` 스키마라 비우면 자리마다
      //    모양이 갈린다(I-10 §5-3).
      this.prisma.material_return.findMany({
        where,
        orderBy: MATERIAL_RETURN_ORDER_BY,
        skip: page.skip,
        take: page.take,
        include: MATERIAL_RETURN_LINE_INCLUDE,
      }),
      this.prisma.material_return.count({ where }),
    ]);
    return pagedResponse(rows.map((row) => materialReturnView(row)), total, page);
  }

  /** 없으면 404(계약 선언). 라인은 `line_no` 오름차순 — 칸이 물리에 실재한다(§5-4). */
  async detail(materialReturnId: number): Promise<MaterialReturnView> {
    const row = await this.prisma.material_return.findUnique({
      where: { material_return_id: BigInt(materialReturnId) },
      include: MATERIAL_RETURN_LINE_INCLUDE,
    });
    if (row === null) throw new NotFoundException('없는 자재 반출입니다.');
    return materialReturnView(row);
  }
}

/** 숫자 축에 글자가 섞이면 400 이다 — 넘기면 Prisma 검증 오류가 500 으로 샌다(`shopfloor-receipt-query.service.ts:70` 사본). */
function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}
