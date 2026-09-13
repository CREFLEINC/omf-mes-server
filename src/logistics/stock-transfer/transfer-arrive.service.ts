import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertWorkerNoExists } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PrismaService } from '../../prisma/prisma.service';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { StockTransferDetail, stockTransferLineView, stockTransferView } from './stock-transfer-view';
import { TransferArriveOrigin, postTransferArrive } from './transfer-posting';

/**
 * 재고 이동 «도착 확정» — 반출과 **다른 트랜잭션**이다(사이에 작업자가 물건을 들고 이동하는
 * 시간이 있다). 이 호출이 원장 2단째를 세운다.
 *
 * ⭐ **한 번만 받는다.** 둘째 `:arrive` 는 400 `STATE_LOCKED` 다 — 되풀이를 요구하는 계약 문장이
 * 0건이고, 허용하면 「도착 회차」와 「회차별 원장 번호·멱등키」라는 새 개념 둘이 생긴다.
 * 부분 도착의 잔여는 `IN_TRANSIT` 차원에 남고 **재고 조정으로 턴다**(결정 — 통보 124).
 */

const STATE_COLUMN = 'logistics.stock_transfer.status_code';

export interface StockTransferArriveLine {
  stockTransferLineId: number; receivedQty: number;
  /** 스캔한 도착 위치가 계획과 다를 때. */
  toLocationId?: number | null;
}

export interface StockTransferArrive {
  businessDate: string; occurredAt: string; lines: StockTransferArriveLine[];
}

export type ArriveContext = {
  workerNo?: string;
  /** **선택**이다 — 없으면 대조하지 않는다(계약 `IfMatchVersionOptional` · C-9). */
  version?: number;
} & ({ actor: LogisticsWriteActor; appUserId?: never } | { appUserId: number; actor?: never });

interface LockedTransfer {
  stock_transfer_id: bigint; stock_transfer_no: string; to_warehouse_id: bigint;
  status_code: string; received_at: Date | null; version_no: number;
}

/** 전표 라인 + 반출이 남긴 원장 라인의 도착 끝점(`issue_transaction_line_id` 로 되읽는다). */
interface ArriveRow {
  stock_transfer_line_id: bigint; line_no: number; item_id: bigint; lot_id: bigint;
  shipped_qty: Prisma.Decimal; uom_id: bigint; from_location_id: bigint; to_location_id: bigint;
  to_warehouse_id: bigint | null; ledger_to_location_id: bigint | null;
  to_quality_status_code: string | null; to_inventory_status_code: string | null;
  from_inventory_status_code: string | null; ownership_type_code: string | null;
  owner_partner_id: bigint | null; handling_unit_id: bigint | null;
}

@Injectable()
export class TransferArriveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly documentState: DocumentStateService,
  ) {}

  async arrive(
    stockTransferId: number, body: StockTransferArrive, context: ArriveContext,
  ): Promise<StockTransferDetail> {
    await assertWorkerNoExists(this.prisma, context.workerNo);
    if (body.lines.length === 0) {
      throw one(field('lines', ERROR_CODE.LINE_REQUIRED, '도착 라인이 1건 이상이어야 합니다.'));
    }
    return this.prisma.$transaction((tx) => this.commit(tx, stockTransferId, body, context));
  }

  /**
   * 업무 거부를 전기 «앞»에서 끝낸다 — 400 이면 원장도 상태도 안 움직인다. 잠금 순서는 전표
   * 한 행 → `post()` 안의 잔액 행(코어가 id 오름차순)이라 교착 창이 없다.
   */
  private async commit(
    tx: Prisma.TransactionClient, stockTransferId: number, body: StockTransferArrive,
    context: ArriveContext,
  ): Promise<StockTransferDetail> {
    const locked = await lockTransfer(tx, stockTransferId);
    if (context.version !== undefined && locked.version_no !== context.version) {
      throw new ConflictException('user', '다른 사용자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.');
    }
    // ⭐ 재도착을 막는 그물은 이것 «하나»다 — 결정적 멱등키는 `(키, 영업일)` 이라 다른 영업일을
    //    실으면 안 걸린다(결정 — 통보 124).
    if (locked.received_at !== null) {
      throw one(field('stockTransferId', ERROR_CODE.STATE_LOCKED, '이미 도착 확정한 이동입니다.'));
    }

    const rows = await arriveRows(tx, locked.stock_transfer_id);
    const known = new Map(rows.map((row) => [Number(row.stock_transfer_line_id), row]));
    await assertLines(tx, body.lines, known, locked.to_warehouse_id);

    // `receivedQty = 0` 인 라인은 원장 라인을 안 만든다(`qty > 0` CHECK) — 수량만 적는다.
    const moving = body.lines.filter((item) => item.receivedQty !== 0);
    const ledgerLineIds = moving.length === 0 ? [] : await postTransferArrive(
      tx, this.posting,
      {
        stockTransferId: locked.stock_transfer_id, stockTransferNo: locked.stock_transfer_no,
        toWarehouseId: locked.to_warehouse_id, businessDate: body.businessDate,
        occurredAt: new Date(body.occurredAt),
        lines: moving.map((item) => {
          const row = known.get(item.stockTransferLineId) as ArriveRow;
          return {
            // 오류 자리는 «본문» 번호로 가리킨다 — 0 수량 라인을 걸러 자리가 어긋난다.
            lineIndex: body.lines.indexOf(item),
            itemId: row.item_id, lotId: row.lot_id, uomId: row.uom_id,
            qty: new Prisma.Decimal(item.receivedQty),
            origin: originOf(row, locked.stock_transfer_no),
            toLocationId: BigInt(item.toLocationId ?? Number(row.to_location_id)),
          };
        }),
      },
      context.actor?.appUserId ?? context.appUserId,
    );

    let posted = 0;
    for (const item of body.lines) {
      await tx.stock_transfer_line.update({
        where: { stock_transfer_line_id: BigInt(item.stockTransferLineId) },
        data: {
          received_qty: item.receivedQty,
          ...(item.toLocationId == null ? {} : { to_location_id: item.toLocationId }),
          // 전기한 라인만 «자리»로 짝짓는다 — 0 수량 라인은 원장 라인이 없어 널로 둔다.
          ...(item.receivedQty === 0 ? {} : { receipt_transaction_line_id: ledgerLineIds[posted] }),
        },
      });
      if (item.receivedQty !== 0) posted += 1;
    }

    // ⭐ 전량 도착에서만 상태를 옮긴다 — 부분 도착은 `REGISTERED` 로 남는다(plan-api.md:752).
    //    본문에 «안» 실린 라인은 0 으로 센다(재도착이 없으니 기존 `received_qty` 도 0 이다).
    const complete = rows.every((row) =>
      new Prisma.Decimal(receivedOf(body.lines, row)).equals(row.shipped_qty));
    const statusCode = complete
      ? this.documentState.assertTransition(
          STATE_COLUMN, 'transfer-arrive', locked.status_code, HttpStatus.BAD_REQUEST).to
      : locked.status_code;

    const changed = await tx.stock_transfer.updateMany({
      where: { stock_transfer_id: locked.stock_transfer_id, version_no: locked.version_no },
      data: {
        // ⛔ 서버 시각이 아니다 — 오프라인 큐가 몇 시간 뒤에 닿는다(C-1).
        received_at: new Date(body.occurredAt), status_code: statusCode,
        updated_by: context.actor?.appUserId ?? context.appUserId ?? null, version_no: { increment: 1 },
      },
    });
    assertUpdated(changed.count);
    if (context.actor?.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
      actor: context.actor.terminalAudit, targetTypeCode: 'STOCK_TRANSFER',
      targetId: locked.stock_transfer_id, eventTypeCode: 'ARRIVE',
    });

    const header = await tx.stock_transfer.findUniqueOrThrow({
      where: { stock_transfer_id: locked.stock_transfer_id },
    });
    const lines = await tx.stock_transfer_line.findMany({
      where: { stock_transfer_id: locked.stock_transfer_id }, orderBy: { line_no: 'asc' },
    });
    // ⛔ ETag 를 안 내린다 — 계약 200 에 응답 헤더 선언이 0건이다.
    return { stockTransfer: stockTransferView(header), lines: lines.map(stockTransferLineView) };
  }
}

/** ⛔ `FOR UPDATE` 를 «건다» — 읽고 판정하고 그 행을 UPDATE 한다(동시 도착 둘이 자물쇠를 지나면 안 된다). */
async function lockTransfer(
  tx: Prisma.TransactionClient, stockTransferId: number,
): Promise<LockedTransfer> {
  const [row] = await tx.$queryRaw<LockedTransfer[]>`
    SELECT stock_transfer_id, stock_transfer_no, to_warehouse_id, status_code, received_at, version_no
      FROM logistics.stock_transfer
     WHERE stock_transfer_id = ${BigInt(stockTransferId)}
       FOR UPDATE`;
  if (row === undefined) throw new NotFoundException('없는 재고 이동입니다.');
  return row;
}

function arriveRows(tx: Prisma.TransactionClient, stockTransferId: bigint): Promise<ArriveRow[]> {
  return tx.$queryRaw<ArriveRow[]>`
    SELECT l.stock_transfer_line_id, l.line_no, l.item_id, l.lot_id, l.shipped_qty, l.uom_id,
           l.from_location_id, l.to_location_id,
           il.to_warehouse_id, il.to_location_id AS ledger_to_location_id,
           il.to_quality_status_code, il.to_inventory_status_code, il.from_inventory_status_code,
           il.ownership_type_code, il.owner_partner_id, il.handling_unit_id
      FROM logistics.stock_transfer_line l
      LEFT JOIN inventory.inventory_transaction_line il
             ON il.inventory_transaction_line_id = l.issue_transaction_line_id
     WHERE l.stock_transfer_id = ${stockTransferId}
     ORDER BY l.line_no`;
}

/**
 * 그물 다섯 — 남의 라인(짚는 행이 없으면 남의 라인을 이 전표로 끌어온다) · 중복 · 반출량 초과 ·
 * 재정의 위치(존재·활성·도착 창고 소속) · ⭐ **재정의 위치 ≠ 출발 위치**. 마지막이 없으면 라인
 * CHECK `ck_stock_transfer_locations` 가 UPDATE 에서 깨져 500 이 샌다(`POST` 에만 있던 그물이다).
 */
async function assertLines(
  tx: Prisma.TransactionClient, items: StockTransferArriveLine[],
  known: Map<number, ArriveRow>, toWarehouseId: bigint,
): Promise<void> {
  const errors: ErrorItem[] = [];
  const seen = new Set<number>();
  for (const [index, item] of items.entries()) {
    const row = known.get(item.stockTransferLineId);
    if (row === undefined) {
      errors.push(at(index, 'stockTransferLineId', ERROR_CODE.INVALID, '이 이동 전표의 라인이 아닙니다.'));
      continue;
    }
    if (seen.has(item.stockTransferLineId)) {
      errors.push(at(index, 'stockTransferLineId', ERROR_CODE.INVALID, '같은 라인을 두 번 실었습니다.'));
    }
    seen.add(item.stockTransferLineId);
    // CHECK `ck_stock_transfer_qty` 를 앞질러 낸다 — 그냥 넘기면 500 이다.
    if (new Prisma.Decimal(item.receivedQty).greaterThan(row.shipped_qty)) {
      errors.push(at(index, 'receivedQty', ERROR_CODE.RANGE, '반출한 수량 이하만 받을 수 있습니다.'));
    }
    if (item.toLocationId == null) continue;
    const location = await tx.location.findUnique({
      where: { location_id: BigInt(item.toLocationId) },
      select: { warehouse_id: true, is_active: true },
    });
    if (location === null || !location.is_active || location.warehouse_id !== toWarehouseId) {
      errors.push(at(index, 'toLocationId', ERROR_CODE.INVALID, '이 창고의 쓸 수 있는 위치가 아닙니다.'));
    } else if (BigInt(item.toLocationId) === row.from_location_id) {
      errors.push(at(index, 'toLocationId', ERROR_CODE.INVALID, '출발 위치와 도착 위치가 같을 수 없습니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/**
 * ⛔ 비었으면 400 이 아니라 **던진다** — 반출이 원장을 안 남겼다는 뜻이라 우리 결함이고, 400 을
 * 주면 화면이 무한 재시도를 돈다(적치 `originOf` 와 같은 등급).
 */
function originOf(row: ArriveRow, transferNo: string): TransferArriveOrigin {
  const { to_warehouse_id: wh, ledger_to_location_id: loc, to_quality_status_code: quality } = row;
  const { to_inventory_status_code: inventory, from_inventory_status_code: restored } = row;
  const ownership = row.ownership_type_code;
  if (wh === null || loc === null || quality === null || inventory === null ||
      restored === null || ownership === null) {
    throw new Error(`반출 원장 라인의 도착 끝점이 비었다: ${transferNo} #${row.line_no}`);
  }
  return {
    warehouseId: wh, locationId: loc, qualityStatusCode: quality, inventoryStatusCode: inventory,
    restoredInventoryStatusCode: restored, ownershipTypeCode: ownership,
    ownerPartnerId: row.owner_partner_id, handlingUnitId: row.handling_unit_id,
  };
}

/** 본문에 «안» 실린 라인은 안 건드린다 — 전량 판정에서는 0 으로 센다. */
const receivedOf = (items: StockTransferArriveLine[], row: ArriveRow): number =>
  items.find((each) => BigInt(each.stockTransferLineId) === row.stock_transfer_line_id)
    ?.receivedQty ?? 0;

const at = (index: number, name: string, code: string, message: string): ErrorItem =>
  field(`lines[${index}].${name}`, code, message);
