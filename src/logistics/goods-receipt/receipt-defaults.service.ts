import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { inboundLineOfLot } from './lot-receivable';

const MATERIAL_RECEIPT = 'MATERIAL';

/**
 * ⚠ `USE_PDA_PUTAWAY` 밖의 코드는 더 내지 않는다 — 구매 입하 LOT 은 PDA 적치로 입고한다(피처 009 · R-2). 계약 enum 에는
 * 옛 클라이언트를 위해 남겨 둔다.
 */
export type ReceiptDefaultIssueCode = 'NOT_FOUND' | 'NOT_RECEIPT_READY' | 'USE_PDA_PUTAWAY';

const MESSAGES: Readonly<Record<ReceiptDefaultIssueCode, string>> = {
  NOT_FOUND: '없는 LOT 입니다.',
  NOT_RECEIPT_READY: '입고 대기인 LOT 이 아닙니다.',
  USE_PDA_PUTAWAY: '구매 입하 자재는 PDA 적치로 입고합니다.',
};

/** 장부 P-150. 못 채운 칸은 null 이고 `issues` 가 까닭이다. */
export interface ReceiptDefaults {
  lotId: number;
  lotNo: string | null;
  itemId: number | null;
  uomId: number | null;
  plantId: number | null;
  inboundReceiptId: number | null;
  inboundReceiptLineId: number | null;
  receiptTypeCode: string;
  receiptQty: number | null;
  warehouseId: number | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  destinationLocationId: number | null;
  destinationLocationCode: string | null;
  qualityStatusCode: string | null;
  inventoryStatusCode: string | null;
  issues: { code: ReceiptDefaultIssueCode; message: string }[];
}

type LotRow = { lot_id: bigint; lot_no: string; item_id: bigint; uom_id: bigint };

/**
 * 입고 기본값 — 관리웹 입고 처리(W-01-10)가 구매 입하 LOT 의 입고 칸을 미리 채우던 자리(사용자 결정 2026-10-29).
 * 피처 009 부터 구매 입하 LOT 은 PDA 적치로 입고하므로(R-2) 입하에서 온 LOT 은 칸을 비우고 `USE_PDA_PUTAWAY` 를 낸다.
 * 입하와 무관한 LOT 은 예전처럼 `NOT_RECEIPT_READY` 다.
 */
@Injectable()
export class ReceiptDefaultsService {
  constructor(private readonly prisma: PrismaService) {}

  async of(lotIds: readonly bigint[]): Promise<ReceiptDefaults[]> {
    const lots = await this.prisma.lot.findMany({
      where: { lot_id: { in: [...lotIds] } },
      select: { lot_id: true, lot_no: true, item_id: true, uom_id: true },
    });
    const lotById = new Map(lots.map((lot) => [lot.lot_id, lot]));
    const inbound = new Set<bigint>();
    for (const lot of lots) if ((await inboundLineOfLot(this.prisma, lot.lot_id)) !== null) inbound.add(lot.lot_id);
    return lotIds.map((lotId) => {
      const lot = lotById.get(lotId);
      if (lot === undefined) return blank(lotId, 'NOT_FOUND');
      return { ...blank(lotId, inbound.has(lotId) ? 'USE_PDA_PUTAWAY' : 'NOT_RECEIPT_READY'), ...lotFields(lot) };
    });
  }
}

function lotFields(lot: LotRow): Pick<ReceiptDefaults, 'lotNo' | 'itemId' | 'uomId'> {
  return { lotNo: lot.lot_no, itemId: Number(lot.item_id), uomId: Number(lot.uom_id) };
}

function blank(lotId: bigint, code: ReceiptDefaultIssueCode): ReceiptDefaults {
  return {
    lotId: Number(lotId), lotNo: null, itemId: null, uomId: null, plantId: null,
    inboundReceiptId: null, inboundReceiptLineId: null, receiptTypeCode: MATERIAL_RECEIPT, receiptQty: null,
    warehouseId: null, warehouseCode: null, warehouseName: null, destinationLocationId: null, destinationLocationCode: null,
    qualityStatusCode: null, inventoryStatusCode: null, issues: [{ code, message: MESSAGES[code] }],
  };
}
