import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { TrackingIssueLine, postTrackingIssue } from './goods-issue-write';
import { claimTransmission } from './tracking-transmission';

type Tx = Prisma.TransactionClient;

/** 컨테이너 하나의 출하 — flowtrack 이 D/O 마다 시리얼을 싣는다(flowtrack 연동 제안 §3-4). */
export interface StockIssue {
  transmissionId: string;
  containerNo: string;
  viNo: string | null;
  invoiceNo: string | null;
  shipDate: string | null;
  destination: string | null;
  qty: number;
  lines: StockIssueLine[];
  businessDate: string;
}

export interface StockIssueLine {
  doNo: string;
  itemCode: string;
  qty: number;
  serialNos: string[];
}

const KIND = 'STOCK_ISSUE';
const ISSUE_TYPE = 'SHIPMENT';
const SOURCE_DOCUMENT_TYPE = 'TRACKING_TRANSMISSION';
/** 등록이 `REGISTERED` 를 넣고, 연동 출하가 이것으로 바꾼다. */
export const SHIPPED = 'SHIPPED';
const LOT_NORMAL = 'NORMAL';

interface SerialRow {
  serial_number_id: bigint;
  serial_no: string;
  lot_id: bigint;
  status_code: string;
  item_code: string;
  plant_id: bigint;
}

interface ShippableLot {
  lotNo: string;
  warehouseId: bigint;
  fgLocationId: bigint;
}

interface Slot {
  lotId: bigint;
  itemId: bigint;
  uomId: bigint;
  locationId: bigint;
  left: Prisma.Decimal;
}

/**
 * 컨테이너 출하를 한 트랜잭션에서 받는다 — 시리얼 → LOT → 그 W/O 완제품 창고의 재고를 D/O 마다 출고 전표 하나로 빼고 시리얼을 출고됨으로 바꾼다.
 * 처리한 전송 번호가 다시 오면 아무것도 하지 않는다. 거절하면 전송 행도 되돌려진다. ERP 로 보내는 것은 없다(MES 장부만).
 */
@Injectable()
export class StockIssueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly posting: InventoryPostingService,
  ) {}

  async receive(input: StockIssue, plantId: bigint): Promise<{ replayed: boolean }> {
    assertShape(input);
    const deliveries = [...new Set(input.lines.map((line) => line.doNo))];
    // 번호는 트랜잭션을 열기 전에 뽑는다(I-2 R-2) — 다시 온 전송은 번호를 버린다(결번 허용).
    const issueNos = await this.numbering.nextMany('GOODS_ISSUE', plantId, input.businessDate, deliveries.length);
    // 본문에 시각이 없다 — 출하일 0시로 잡으면 같은 날 포장한 입고보다 앞선다.
    const occurredAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      const transmission = await claimTransmission(tx, {
        transmissionId: input.transmissionId, kindCode: KIND, plantId, workOrderId: null, payload: input,
      });
      if (transmission === null) return { replayed: true };
      const serials = await lockSerials(tx, input, plantId);
      const lots = await shippableLots(tx, [...new Set([...serials.values()].map((serial) => serial.lot_id))]);
      const plans = allocate(input, deliveries, serials, lots, await lockStock(tx, lots));

      const issueIds: bigint[] = [];
      for (const [index, plan] of plans.entries()) {
        const { goodsIssueId } = await postTrackingIssue(tx, this.posting, {
          goodsIssueNo: issueNos[index], issueTypeCode: ISSUE_TYPE, sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
          sourceDocumentId: transmission, warehouseId: plan.warehouseId, occurredAt, businessDate: input.businessDate,
          remarks: remarksOf(input, plan.doNo),
        }, plan.lines);
        issueIds.push(goodsIssueId);
      }
      await tx.serial_number.updateMany({
        where: { serial_number_id: { in: [...serials.values()].map((serial) => serial.serial_number_id) } },
        data: { status_code: SHIPPED, version_no: { increment: 1 } },
      });
      await tx.tracking_transmission_document.createMany({
        data: issueIds.map((id) => ({ tracking_transmission_id: transmission, document_type_code: 'GOODS_ISSUE', document_id: id })),
      });
      return { replayed: false };
    }, { timeout: 15_000, maxWait: 5_000 });
  }
}

function assertShape(input: StockIssue): void {
  const errors: ErrorItem[] = [];
  const total = input.lines.reduce((sum, line) => sum + line.qty, 0);
  if (total !== input.qty) errors.push(field('qty', ERROR_CODE.INVALID, `수량(${input.qty})이 줄 수량의 합(${total})과 다릅니다.`));
  const seen = new Set<string>();
  for (const [i, line] of input.lines.entries()) {
    if (line.qty !== line.serialNos.length) {
      errors.push(field(`lines[${i}].qty`, ERROR_CODE.INVALID, `수량(${line.qty})이 시리얼 수(${line.serialNos.length})와 다릅니다.`));
    }
    for (const [j, serialNo] of line.serialNos.entries()) {
      if (seen.has(serialNo)) errors.push(field(`lines[${i}].serialNos[${j}]`, ERROR_CODE.INVALID, `본문 안에 같은 시리얼이 두 번 있습니다: ${serialNo}`));
      seen.add(serialNo);
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** 같은 시리얼을 두 전송이 함께 내보내지 못하게 잠근다. 다른 공장의 시리얼은 없는 시리얼과 같게 답한다. */
async function lockSerials(tx: Tx, input: StockIssue, plantId: bigint): Promise<Map<string, SerialRow>> {
  const rows = await tx.$queryRaw<SerialRow[]>`
    SELECT s.serial_number_id, s.serial_no, s.lot_id, s.status_code, i.item_code, l.plant_id
      FROM trace.serial_number s
      JOIN mdm.item i ON i.item_id = s.item_id
      JOIN trace.lot l ON l.lot_id = s.lot_id
     WHERE s.serial_no IN (${Prisma.join(input.lines.flatMap((line) => line.serialNos))})
     ORDER BY s.serial_number_id
       FOR UPDATE OF s`;
  const found = new Map(rows.filter((row) => row.plant_id === plantId).map((row) => [row.serial_no, row]));
  const errors: ErrorItem[] = [];
  for (const [i, line] of input.lines.entries()) {
    for (const [j, serialNo] of line.serialNos.entries()) {
      const path = `lines[${i}].serialNos[${j}]`;
      const row = found.get(serialNo);
      if (row === undefined) errors.push(field(path, ERROR_CODE.INVALID, `MES 에 없는 시리얼입니다: ${serialNo}`));
      else if (row.item_code !== line.itemCode) {
        errors.push(field(path, ERROR_CODE.INVALID, `시리얼 ${serialNo} 의 품목(${row.item_code})이 줄의 품목과 다릅니다.`));
      } else if (row.status_code === SHIPPED) errors.push(field(path, ERROR_CODE.STATE_LOCKED, `이미 출고된 시리얼입니다: ${serialNo}`));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return found;
}

/** 정상이고 보류가 없는 W/O 생산 LOT 만 낸다 — 포장 뒤 MES 에서 보류·불량으로 바꾼 LOT 이 컨테이너에 실렸다면 드러나게 거절한다. */
async function shippableLots(tx: Tx, lotIds: bigint[]): Promise<Map<bigint, ShippableLot>> {
  const lots = await tx.lot.findMany({
    where: { lot_id: { in: lotIds } },
    select: {
      lot_id: true, lot_no: true, status_code: true, source_type_code: true, source_id: true,
      _count: { select: { lot_hold: { where: { released_at: null } } } },
    },
  });
  const workOrders = await tx.work_order.findMany({
    where: { work_order_id: { in: lots.filter((lot) => lot.source_type_code === WORK_ORDER_LOT_SOURCE).map((lot) => lot.source_id) } },
    select: { work_order_id: true, default_fg_location_id: true, location_work_order_default_fg_location_idTolocation: { select: { warehouse_id: true } } },
  });
  const workOrderOf = new Map(workOrders.map((row) => [row.work_order_id, row]));
  const errors: ErrorItem[] = [];
  const shippable = new Map<bigint, ShippableLot>();
  for (const lot of lots) {
    const workOrder = lot.source_type_code === WORK_ORDER_LOT_SOURCE ? workOrderOf.get(lot.source_id) : undefined;
    const fg = workOrder?.location_work_order_default_fg_location_idTolocation;
    if (lot.status_code !== LOT_NORMAL || lot._count.lot_hold > 0) {
      errors.push({ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: `LOT ${lot.lot_no} 이 정상이 아닙니다(${lot.status_code}) — MES 의 LOT 보류·품질 상태를 확인하세요.` });
    } else if (fg === undefined || fg === null) {
      errors.push({ scope: 'screen', code: ERROR_CODE.INVALID, message: `LOT ${lot.lot_no} 의 W/O 에 완제품 위치가 없습니다.` });
    } else {
      shippable.set(lot.lot_id, { lotNo: lot.lot_no, warehouseId: fg.warehouse_id, fgLocationId: workOrder?.default_fg_location_id as bigint });
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return shippable;
}

/** 그 LOT 의 완제품 창고에서 뺄 수 있는 재고 — 정상·가용. W/O 완제품 위치가 먼저고 나머지는 위치 순이다. */
async function lockStock(tx: Tx, lots: Map<bigint, ShippableLot>): Promise<Slot[]> {
  const rows = await tx.$queryRaw<{
    warehouse_id: bigint; location_id: bigint; item_id: bigint; lot_id: bigint; uom_id: bigint;
    quality_status_code: string; inventory_status_code: string; available_qty: Prisma.Decimal | null;
  }[]>`
    SELECT warehouse_id, location_id, item_id, lot_id, uom_id, quality_status_code, inventory_status_code, available_qty
      FROM inventory.inventory_balance
     WHERE lot_id IN (${Prisma.join([...lots.keys()])})
     ORDER BY inventory_balance_id
       FOR UPDATE`;
  const fgFirst = (row: { lot_id: bigint; location_id: bigint }) => (row.location_id === lots.get(row.lot_id)?.fgLocationId ? 0 : 1);
  return rows
    .filter((row) => row.warehouse_id === lots.get(row.lot_id)?.warehouseId && row.quality_status_code === 'NORMAL'
      && row.inventory_status_code === 'AVAILABLE' && row.available_qty !== null && row.available_qty.gt(0))
    .sort((a, b) => fgFirst(a) - fgFirst(b) || (a.location_id < b.location_id ? -1 : a.location_id > b.location_id ? 1 : 0))
    .map((row) => ({ lotId: row.lot_id, itemId: row.item_id, uomId: row.uom_id, locationId: row.location_id, left: row.available_qty as Prisma.Decimal }));
}

/** D/O 마다 출고 줄 — 한 D/O 는 한 창고에서 나간다. 모자란 LOT 은 모두 모아 거절한다. */
function allocate(
  input: StockIssue,
  deliveries: string[],
  serials: Map<string, SerialRow>,
  lots: Map<bigint, ShippableLot>,
  slots: Slot[],
): { doNo: string; warehouseId: bigint; lines: TrackingIssueLine[] }[] {
  const errors: ErrorItem[] = [];
  const plans = deliveries.map((doNo) => {
    const need = new Map<bigint, number>();
    for (const line of input.lines.filter((entry) => entry.doNo === doNo)) {
      for (const serialNo of line.serialNos) {
        const lotId = (serials.get(serialNo) as SerialRow).lot_id;
        need.set(lotId, (need.get(lotId) ?? 0) + 1);
      }
    }
    const warehouses = new Set([...need.keys()].map((lotId) => (lots.get(lotId) as ShippableLot).warehouseId));
    if (warehouses.size > 1) {
      errors.push({ scope: 'screen', code: ERROR_CODE.INVALID, message: `D/O ${doNo} 의 제품이 창고 둘 이상에 있습니다 — MES 의 W/O 완제품 창고를 확인하세요.` });
    }
    const lines: TrackingIssueLine[] = [];
    for (const [lotId, count] of need) {
      let left = new Prisma.Decimal(count);
      for (const slot of slots.filter((entry) => entry.lotId === lotId)) {
        const take = Prisma.Decimal.min(left, slot.left);
        if (take.lte(0)) continue;
        slot.left = slot.left.minus(take);
        left = left.minus(take);
        lines.push({ itemId: slot.itemId, lotId, uomId: slot.uomId, locationId: slot.locationId, qty: take });
      }
      if (left.gt(0)) {
        errors.push({
          scope: 'screen', code: ERROR_CODE.NEGATIVE_BALANCE,
          message: `LOT ${(lots.get(lotId) as ShippableLot).lotNo} 의 출고할 수 있는 재고가 ${left.toString()}개 모자랍니다(D/O ${doNo}) — 입고이동이 먼저 왔는지 확인하세요.`,
        });
      }
    }
    return { doNo, warehouseId: [...warehouses][0], lines };
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return plans;
}

function remarksOf(input: StockIssue, doNo: string): string {
  return [
    `Container ${input.containerNo}`, input.viNo === null ? null : `VI ${input.viNo}`, input.invoiceNo === null ? null : `Invoice ${input.invoiceNo}`,
    `D/O ${doNo}`, input.shipDate === null ? null : `Ship date ${input.shipDate}`, input.destination === null ? null : `Destination ${input.destination}`,
  ].filter((part) => part !== null).join(' · ');
}
