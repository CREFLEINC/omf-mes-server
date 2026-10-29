import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PUTAWAY_STAGING } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { inboundLineOfLot, receivableQtyOf } from './lot-receivable';

/** 입고 대기 LOT 상태 — `inbound-stage.ts` 의 RECEIPT_READY 와 같다(검사 대기·폐기는 아니다). 합격·무검사는 정상, IQC 불합격은 불량. */
const STATUSES: Readonly<Record<string, { quality: string; inventory: string }>> = {
  NORMAL: { quality: 'NORMAL', inventory: 'AVAILABLE' },
  // 불량은 불량창고에 두고 처분·특채를 기다린다 — 쓰지 못하게 막는 것은 LOT 상태가 한다(사용자 결정 2026-10-29).
  DEFECTIVE: { quality: 'DEFECTIVE', inventory: 'ON_HOLD' },
};
const RECEIPT_CANCEL_STATUSES = ['CANCELLED', 'CANCEL_REQUESTED'];
const MATERIAL_RECEIPT = 'MATERIAL';

export type ReceiptDefaultIssueCode =
  | 'NOT_FOUND'
  | 'NOT_RECEIPT_READY'
  | 'NO_ERP_WAREHOUSE'
  | 'MULTIPLE_ERP_WAREHOUSES'
  | 'NO_MES_WAREHOUSE'
  | 'OTHER_PLANT_WAREHOUSE'
  | 'NO_DEFECT_WAREHOUSE'
  | 'MULTIPLE_DEFECT_WAREHOUSES'
  | 'NO_STAGING_LOCATION';

const MESSAGES: Readonly<Record<ReceiptDefaultIssueCode, string>> = {
  NOT_FOUND: '없는 LOT 입니다.',
  NOT_RECEIPT_READY: '입고 대기인 LOT 이 아닙니다.',
  NO_ERP_WAREHOUSE: '발주 라인에 ERP 창고가 없습니다.',
  MULTIPLE_ERP_WAREHOUSES: '이 LOT 이 걸린 발주 라인들의 ERP 창고가 서로 다릅니다.',
  NO_MES_WAREHOUSE: 'ERP 창고의 MES 창고가 없거나 꺼져 있습니다 — ERP 연동 현황의 창고에서 만듭니다.',
  OTHER_PLANT_WAREHOUSE: 'ERP 창고의 MES 창고가 입하와 다른 공장에 있습니다.',
  NO_DEFECT_WAREHOUSE: '공장에 불량창고가 없습니다.',
  MULTIPLE_DEFECT_WAREHOUSES: '공장에 불량창고가 둘 이상입니다.',
  NO_STAGING_LOCATION: '창고에 적치 대기 자리가 없습니다.',
};

/** 장부 P-150. 못 채운 칸은 null 이고 `issues` 가 까닭이다 — 사람이 그 칸만 고른다. */
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

type LotRow = { lot_id: bigint; lot_no: string; item_id: bigint; uom_id: bigint; status_code: string };
type LineRow = Prisma.inbound_receipt_lineGetPayload<{ select: typeof LINE_SELECT }>;
type WarehouseRow = { warehouse_id: bigint; warehouse_code: string; warehouse_name: string; plant_id: bigint };

const LINE_SELECT = {
  inbound_receipt_line_id: true,
  inbound_receipt: { select: { inbound_receipt_id: true, plant_id: true, status_code: true } },
  inbound_receipt_po_allocation: { select: { purchase_order_line: { select: { erp_storage_location_code: true } } } },
} satisfies Prisma.inbound_receipt_lineSelect;

/**
 * 입고 기본값 — 입고는 사람이 하되 서버가 입고 칸을 미리 채운다(사용자 결정 2026-10-29). 창고는 발주 라인의 ERP 창고
 * (`SL_CD`)와 같은 코드의 MES 창고 — ERP 구매입고 송신도 그 값을 쓴다 — 불량은 공장 불량창고. 위치는 그 창고의 적치 대기 자리.
 * 영업일·입고 시각은 화면이 채운다(C-8).
 */
@Injectable()
export class ReceiptDefaultsService {
  constructor(private readonly prisma: PrismaService) {}

  async of(lotIds: readonly bigint[]): Promise<ReceiptDefaults[]> {
    const [lots, receivable] = await Promise.all([
      this.prisma.lot.findMany({
        where: { lot_id: { in: [...lotIds] } },
        select: { lot_id: true, lot_no: true, item_id: true, uom_id: true, status_code: true },
      }),
      receivableQtyOf(this.prisma, lotIds),
    ]);
    const lotById = new Map(lots.map((lot) => [lot.lot_id, lot]));
    const lineOf = new Map<bigint, bigint | null>();
    for (const lot of lots) lineOf.set(lot.lot_id, await inboundLineOfLot(this.prisma, lot.lot_id));
    const lines = await this.prisma.inbound_receipt_line.findMany({
      where: { inbound_receipt_line_id: { in: [...lineOf.values()].filter((id): id is bigint => id !== null) } },
      select: LINE_SELECT,
    });
    const lineById = new Map(lines.map((line) => [line.inbound_receipt_line_id, line]));
    const places = await this.places(lines, lots);

    return lotIds.map((lotId) => {
      const lot = lotById.get(lotId);
      if (lot === undefined) return blank(lotId, 'NOT_FOUND');
      const lineId = lineOf.get(lotId) ?? null;
      const line = lineId === null ? undefined : lineById.get(lineId);
      const qty = receivable.get(lotId) ?? new Prisma.Decimal(0);
      const statuses = STATUSES[lot.status_code];
      if (line === undefined || statuses === undefined || qty.lessThanOrEqualTo(0)
        || RECEIPT_CANCEL_STATUSES.includes(line.inbound_receipt.status_code)) {
        return { ...blank(lotId, 'NOT_RECEIPT_READY'), ...lotFields(lot) };
      }
      return { ...ready(lot, line, qty, statuses), ...places.pick(lot, line) };
    });
  }

  /** 창고·적치 대기 자리를 한꺼번에 읽어 두고 LOT 마다 고른다. */
  private async places(lines: LineRow[], lots: LotRow[]): Promise<{
    pick: (lot: LotRow, line: LineRow) => Pick<ReceiptDefaults,
      'warehouseId' | 'warehouseCode' | 'warehouseName' | 'destinationLocationId' | 'destinationLocationCode' | 'issues'>;
  }> {
    const codes = [...new Set(lines.flatMap(erpCodesOf))];
    const plants = [...new Set(lines.map((line) => line.inbound_receipt.plant_id))];
    const select = { warehouse_id: true, warehouse_code: true, warehouse_name: true, plant_id: true } as const;
    const [byCode, defects] = await Promise.all([
      this.prisma.warehouse.findMany({ where: { warehouse_code: { in: codes }, is_active: true }, select }),
      lots.some((lot) => lot.status_code === 'DEFECTIVE')
        ? this.prisma.warehouse.findMany({ where: { plant_id: { in: plants }, is_defect: true, is_active: true }, select })
        : Promise.resolve<WarehouseRow[]>([]),
    ]);
    const staging = await this.prisma.location.findMany({
      where: {
        warehouse_id: { in: [...byCode, ...defects].map((row) => row.warehouse_id) },
        system_role_code: PUTAWAY_STAGING,
        is_active: true,
      },
      select: { warehouse_id: true, location_id: true, location_code: true },
    });
    const stagingOf = new Map(staging.map((row) => [row.warehouse_id, row]));

    const located = (warehouse: WarehouseRow) => {
      const slot = stagingOf.get(warehouse.warehouse_id);
      return {
        warehouseId: Number(warehouse.warehouse_id),
        warehouseCode: warehouse.warehouse_code,
        warehouseName: warehouse.warehouse_name,
        destinationLocationId: slot === undefined ? null : Number(slot.location_id),
        destinationLocationCode: slot?.location_code ?? null,
        issues: slot === undefined ? [issue('NO_STAGING_LOCATION')] : [],
      };
    };
    const unplaced = (code: ReceiptDefaultIssueCode) => ({
      warehouseId: null, warehouseCode: null, warehouseName: null,
      destinationLocationId: null, destinationLocationCode: null, issues: [issue(code)],
    });

    return {
      pick: (lot, line) => {
        const plantId = line.inbound_receipt.plant_id;
        if (lot.status_code === 'DEFECTIVE') {
          const candidates = defects.filter((row) => row.plant_id === plantId);
          if (candidates.length === 0) return unplaced('NO_DEFECT_WAREHOUSE');
          if (candidates.length > 1) return unplaced('MULTIPLE_DEFECT_WAREHOUSES');
          return located(candidates[0]);
        }
        const erpCodes = [...new Set(erpCodesOf(line))];
        if (erpCodes.length === 0) return unplaced('NO_ERP_WAREHOUSE');
        if (erpCodes.length > 1) return unplaced('MULTIPLE_ERP_WAREHOUSES');
        // ERP 코드 하나에 MES 창고 하나다(장부 P-148) — 결정 전 자료가 둘이면 입하 공장의 것을 고른다.
        const matches = byCode.filter((row) => row.warehouse_code === erpCodes[0]);
        if (matches.length === 0) return unplaced('NO_MES_WAREHOUSE');
        const own = matches.find((row) => row.plant_id === plantId);
        return own === undefined ? unplaced('OTHER_PLANT_WAREHOUSE') : located(own);
      },
    };
  }
}

function erpCodesOf(line: LineRow): string[] {
  return line.inbound_receipt_po_allocation
    .map((allocation) => allocation.purchase_order_line.erp_storage_location_code?.trim() ?? '')
    .filter((code) => code !== '');
}

function ready(
  lot: LotRow, line: LineRow, qty: Prisma.Decimal, statuses: { quality: string; inventory: string },
): Omit<ReceiptDefaults, 'warehouseId' | 'warehouseCode' | 'warehouseName' | 'destinationLocationId' | 'destinationLocationCode' | 'issues'> {
  return {
    lotId: Number(lot.lot_id),
    ...lotFields(lot),
    plantId: Number(line.inbound_receipt.plant_id),
    inboundReceiptId: Number(line.inbound_receipt.inbound_receipt_id),
    inboundReceiptLineId: Number(line.inbound_receipt_line_id),
    receiptTypeCode: MATERIAL_RECEIPT,
    receiptQty: qty.toNumber(),
    qualityStatusCode: statuses.quality,
    inventoryStatusCode: statuses.inventory,
  };
}

function lotFields(lot: LotRow): Pick<ReceiptDefaults, 'lotNo' | 'itemId' | 'uomId'> {
  return { lotNo: lot.lot_no, itemId: Number(lot.item_id), uomId: Number(lot.uom_id) };
}

function blank(lotId: bigint, code: ReceiptDefaultIssueCode): ReceiptDefaults {
  return {
    lotId: Number(lotId), lotNo: null, itemId: null, uomId: null, plantId: null,
    inboundReceiptId: null, inboundReceiptLineId: null, receiptTypeCode: MATERIAL_RECEIPT, receiptQty: null,
    warehouseId: null, warehouseCode: null, warehouseName: null, destinationLocationId: null, destinationLocationCode: null,
    qualityStatusCode: null, inventoryStatusCode: null, issues: [issue(code)],
  };
}

const issue = (code: ReceiptDefaultIssueCode) => ({ code, message: MESSAGES[code] });
