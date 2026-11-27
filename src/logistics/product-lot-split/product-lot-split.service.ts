import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit, TerminalWorkerAuditActor } from '../../audit/terminal-worker-audit';
import { DocumentIssueWriteService } from '../../app/document-issue/document-issue-write.service';
import { productionLotLabelQty } from '../../app/document-issue/production-lot-label-qty';
import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { LotHoldService, PRODUCT_LOT_SPLIT_SOURCE, lockLotSplitFamilies, splitLotWithin } from '../../core/lot';
import {
  SplitBlock,
  loadSplitLocations,
  loadSplitLotFacts,
  locationBlocked,
  lotBlocked,
  qtyViolation,
} from './product-lot-split-rules';
import type { ProductLotSplitResult } from './product-lot-split-view';

/** 계약 `ProductLotSplitCreate` — 영업일은 단말이 보낸다(C-8: 서버가 수신 시각으로 다시 잡지 않는다). */
export interface ProductLotSplitBody {
  lotId?: number;
  locationId?: number;
  qty?: number;
  businessDate?: string;
  occurredAt?: string;
}

/** 분리 원장의 거래 유형 — 008 부분 출고 분할과 같은 자유 문자열이다. 원천 문서가 둘을 가른다. */
const LOT_SPLIT_TRANSACTION = 'LOT_SPLIT';
const SYSTEM_REISSUE_REASON = 'LOT_SPLIT';

export interface SplitActor extends TerminalWorkerAuditActor {
  /** 발행 기록 멱등 문맥(분리 요청의 것) — 발행 서비스가 칸을 요구할 뿐 따로 쓰지 않는다. */
  fingerprint: string;
}

/**
 * 생산 LOT 수량 분리(POP P-04-08 · 피처 013 R-1·R-7·R-8) — 한 트랜잭션에서
 * LOT 잠금 → 분할 번호 잠금 → 잔액 잠금 → 막는 조건 → 자식 LOT·분리 기록 → 원장 `LOT_SPLIT` → 라벨 발행 기록 2건.
 * ⭐ 발행이 막히면(라벨 권한 없는 단말 등) 자식·원장·분리 기록이 함께 롤백된다(FR-002).
 */
@Injectable()
export class ProductLotSplitService {
  constructor(
    private readonly posting: InventoryPostingService,
    private readonly holds: LotHoldService,
    private readonly issues: DocumentIssueWriteService,
  ) {}

  async splitWithin(tx: Prisma.TransactionClient, body: ProductLotSplitBody, actor: SplitActor): Promise<ProductLotSplitResult> {
    const input = parseBody(body);
    const [locked] = await this.holds.lockLotsWithin(tx, [input.lotId]);
    if (locked === undefined) throw one(field('lotId', ERROR_CODE.INVALID, '이 공장의 LOT 이 아닙니다.'));
    await lockLotSplitFamilies(tx, [locked.lot_no]);
    const lot = await loadSplitLotFacts(tx, actor.plantId, { lotId: input.lotId });
    if (lot === undefined) throw one(field('lotId', ERROR_CODE.INVALID, '이 공장의 LOT 이 아닙니다.'));
    const balances = await lockBalancesByItemLot(tx, lot.item_id, lot.lot_id);
    throwIfBlocked(lotBlocked(lot));
    const location = (await loadSplitLocations(tx, actor.plantId, lot.lot_id)).find((row) => row.location_id === input.locationId);
    if (location === undefined) throw one(field('locationId', ERROR_CODE.RANGE, '그 위치에 이 LOT 재고가 없습니다.'));
    throwIfBlocked(locationBlocked(location));
    const rangeError = qtyViolation(input.qty, new Prisma.Decimal(location.on_hand), lot.decimal_scale);
    if (rangeError !== null) throw one(field('qty', ERROR_CODE.RANGE, rangeError));
    const dimension = balances.find((row) => row.locationId === input.locationId && new Prisma.Decimal(row.on_hand_qty).greaterThan(0));
    if (dimension === undefined) throw new Error('잠근 잔액 행에서 분리 위치를 찾지 못했다');

    const [{ id }] = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT nextval(pg_get_serial_sequence('trace.product_lot_split', 'product_lot_split_id')) AS id`;
    const occurredAt = input.occurredAt ?? new Date();
    const child = await splitLotWithin(tx, {
      parentLotId: lot.lot_id, qty: input.qty, sourceTypeCode: PRODUCT_LOT_SPLIT_SOURCE, sourceId: id,
      sourceEventTypeCode: PRODUCT_LOT_SPLIT_SOURCE, sourceEventId: id, occurredAt, createdBy: null,
    });
    const split = await tx.product_lot_split.create({ data: {
      product_lot_split_id: id, plant_id: actor.plantId, parent_lot_id: lot.lot_id, child_lot_id: child.lotId,
      warehouse_id: location.warehouse_id, location_id: location.location_id, split_qty: input.qty, uom_id: lot.uom_id,
      split_at: occurredAt, split_worker_no: actor.workerNo, split_terminal_id: actor.terminalId,
    } });
    await this.post(tx, input, split.product_lot_split_id, { ...lot, child_lot_id: child.lotId }, dimension, occurredAt, actor);
    const issued = await this.issues.issueWithin(
      tx,
      {
        documentTypeCode: 'PRODUCTION_LOT_LABEL',
        targets: [{ targetTypeCode: 'LOT', targetId: Number(lot.lot_id) }, { targetTypeCode: 'LOT', targetId: Number(child.lotId) }],
        reissueReasonCode: SYSTEM_REISSUE_REASON,
      },
      {
        key: actor.correlationId, fingerprint: actor.fingerprint, successStatus: 200,
        workerNo: actor.workerNo, terminalId: actor.terminalId,
        terminalAudit: { workerNo: actor.workerNo, terminalId: actor.terminalId, plantId: actor.plantId, correlationId: actor.correlationId, operationKey: actor.operationKey },
      },
      { systemReissueReason: SYSTEM_REISSUE_REASON },
    );
    await recordTerminalWorkerAudit(tx, {
      actor, targetTypeCode: 'PRODUCT_LOT_SPLIT', targetId: split.product_lot_split_id, eventTypeCode: 'SPLIT',
    });
    const qty = await productionLotLabelQty(tx, [lot.lot_id, child.lotId]);
    const [parentIssue, childIssue] = issued.items;
    return {
      productLotSplitId: Number(split.product_lot_split_id),
      parentLot: {
        lotId: Number(lot.lot_id), lotNo: lot.lot_no, qty: Number(qty.get(lot.lot_id) ?? 0),
        documentIssueLogId: parentIssue.documentIssueLogId, issueSeq: parentIssue.issueSeq,
      },
      childLot: {
        lotId: Number(child.lotId), lotNo: child.lotNo, qty: Number(qty.get(child.lotId) ?? 0),
        documentIssueLogId: childIssue.documentIssueLogId, issueSeq: childIssue.issueSeq,
      },
      location: { locationId: Number(location.location_id), locationCode: location.location_code, warehouseCode: location.warehouse_code },
      splitAt: split.split_at.toISOString(),
    };
  }

  /** 같은 자리(창고·위치·품질·재고 상태·소유)에서 부모 → 자식. 거래번호 `PLS-{id}`(R-1). */
  private async post(
    tx: Prisma.TransactionClient,
    input: ParsedBody,
    splitId: bigint,
    lot: { lot_id: bigint; child_lot_id: bigint; item_id: bigint; uom_id: bigint },
    dimension: Awaited<ReturnType<typeof lockBalancesByItemLot>>[number],
    occurredAt: Date,
    actor: SplitActor,
  ): Promise<void> {
    const transactionNo = `PLS-${splitId}`;
    const at = {
      warehouseId: Number(dimension.warehouseId), locationId: Number(dimension.locationId),
      qualityStatusCode: dimension.quality_status_code, inventoryStatusCode: dimension.inventory_status_code,
    };
    const common = {
      itemId: Number(lot.item_id), qty: Number(input.qty), uomId: Number(lot.uom_id), ownershipTypeCode: dimension.ownership_type_code,
      ...(dimension.owner_partner_id === null ? {} : { ownerPartnerId: Number(dimension.owner_partner_id) }),
    };
    const posted = await this.posting.post(tx, {
      businessDate: input.businessDate, occurredAt, transactionTypeCode: LOT_SPLIT_TRANSACTION, transactionNo, statusCode: 'POSTED',
      plantId: Number(actor.plantId), sourceDocumentTypeCode: PRODUCT_LOT_SPLIT_SOURCE, sourceDocumentId: Number(splitId),
      idempotencyKey: `${LOT_SPLIT_TRANSACTION}:${transactionNo}`,
      lines: [{ ...common, lotId: Number(lot.lot_id), from: at }, { ...common, lotId: Number(lot.child_lot_id), to: at }],
    });
    if (posted.alreadyPosted) throw new Error(`분리 원장이 이미 있다: ${transactionNo}`);
  }
}

interface ParsedBody {
  lotId: bigint;
  locationId: bigint;
  qty: Prisma.Decimal;
  businessDate: string;
  occurredAt?: Date;
}

function parseBody(body: ProductLotSplitBody): ParsedBody {
  const errors = [];
  if (body.lotId === undefined) errors.push(field('lotId', ERROR_CODE.REQUIRED, 'LOT 을 스캔하세요.'));
  if (body.locationId === undefined) errors.push(field('locationId', ERROR_CODE.REQUIRED, '위치를 고르세요.'));
  if (body.qty === undefined) errors.push(field('qty', ERROR_CODE.REQUIRED, '분리 수량을 넣으세요.'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate ?? '')) errors.push(field('businessDate', ERROR_CODE.INVALID, '영업일(YYYY-MM-DD)이 필요합니다.'));
  if (errors.length > 0) throw new ContractException(400, errors);
  return {
    lotId: BigInt(body.lotId as number),
    locationId: BigInt(body.locationId as number),
    qty: new Prisma.Decimal(body.qty as number),
    businessDate: body.businessDate as string,
    ...(body.occurredAt === undefined ? {} : { occurredAt: new Date(body.occurredAt) }),
  };
}

function throwIfBlocked(block: SplitBlock | null): void {
  if (block === null) return;
  throw new ConflictException('user', BLOCK_MESSAGE[block.code] ?? '분리할 수 없는 LOT 입니다.', { code: block.code, detail: block.detail });
}

const BLOCK_MESSAGE: Record<string, string> = {
  NOT_PRODUCTION_LOT: '생산 LOT 만 분리할 수 있습니다.',
  SPLIT_SERIAL_LOT: '시리얼 관리 품목은 분리할 수 없습니다.',
  INVALID_STATE: '보류·불량·폐기·무효 LOT 은 분리할 수 없습니다.',
  LOT_SPLIT_UNCONFIRMED: '분리 확인 전인 LOT 입니다. PDA 에서 두 라벨을 먼저 확인하세요.',
  LOT_ALREADY_RESERVED: '다른 작업에 잡힌 LOT 입니다. 분리할 수 없습니다.',
  PUTAWAY_PENDING: '적치를 먼저 끝내세요.',
  NOT_PRODUCT_WAREHOUSE: '제품 창고 위치의 재고만 분리할 수 있습니다.',
  MIXED_STOCK_STATUS: '그 위치에 상태가 다른 재고가 섞여 있어 분리할 수 없습니다.',
};
