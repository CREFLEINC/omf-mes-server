import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import type { MaterialReturnActor } from '../../auth/terminal-material-return-scope';
import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { idempotencyContextOf } from '../../common/master';
import { InventoryPostingService } from '../../core/inventory-posting';
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import type { PostingLine } from '../../core/inventory-posting';
import { arrivalLocationId } from '../../core/material-issue/production-warehouse';
import { NumberingService } from '../../core/numbering';
import { RECEIPT_STATUS_OF_LOT } from '../../logistics/goods-receipt/receipt-gate';
import { VERDICT_MESSAGES, designationAddable, loadVerdictLocation, verdictOf } from '../../logistics/putaway-direct/location-verdict';
import { unprintedSplitLotIds } from '../../logistics/split-material-lot/split-material-lot-query.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FinalCloseProbe } from './final-close';
import { MATERIAL_RETURN_LINE_INCLUDE, MaterialReturnView, materialReturnView } from './material-return-view';
import { MATERIAL_RETURN_DOCUMENT, RETURN_MESSAGES, RETURN_RECEIVED } from './material-return.constants';
import { attributionOf } from './return-attribution';
import { ReturnLotFacts, loadReturnLots } from './return-lots';

/** 계약 `MaterialReturnReceiveLine` — W/O 는 W/O 로 찾기 줄만, 위치는 PDA 만 싣는다. */
export interface MaterialReturnReceiveLine {
  lotId: number;
  returnQty: number;
  workOrderId?: number | null;
  destinationLocationId?: number | null;
  confirmUndesignated?: boolean;
}

/** 계약 `MaterialReturnReceive` — 업무일·발생 시각은 단말 값(C-8). */
export interface MaterialReturnReceive {
  businessDate: string;
  occurredAt: string;
  lines: MaterialReturnReceiveLine[];
}

interface Endpoint { warehouseId: bigint; locationId: bigint; quality: string; inventory: string }

/** 줄 하나의 계획 — LOT 을 잠근 뒤 한 번 더 세운다. */
interface PlannedLine {
  lot: ReturnLotFacts;
  qty: Prisma.Decimal;
  workOrderId: bigint | null;
  attributionCode: string;
  to: Endpoint;
  /** 미지정 위치에 받으면 그 위치 보관 품목에 더한다(피처 009 FR-017a 와 같다). */
  addDesignation: boolean;
  /** 위치 없이 적치 대기로 받은 줄 — 적치 지시를 하나 만든다(2026-11-28 사용자 결정). 위치를 스캔해 받은 줄은 거짓. */
  staged: boolean;
}

const NUMBER_RETRY = 3;
const OWNED = 'OWNED';
const PUTAWAY_PENDING = 'PENDING';
const CORE_RESTRICTED = 'LOCATION_ITEM_RESTRICTED';

/**
 * 반납 입고(피처 019 · research R-1·R-2·R-3) — 한 트랜잭션에서 줄마다 LOT 을 잠그고(`FOR NO KEY UPDATE` · 016 반제품 투입과
 * 같은 자물쇠) 귀속 출고 라인·반납 가능 양을 다시 센 뒤, 반납 머리·줄과 원장 한 건(거래 유형·원천 `MATERIAL_RETURN`)을 쓴다.
 *
 * ⛔ ERP 로 보내지 않는다(FR-008 — 아웃박스 없음). ⛔ 취소·상태 전이가 없다(FR-009).
 * ⛔ 거절(400·409)은 채번 «전»에 한 번 내고, 잠근 뒤 같은 판정을 다시 한다.
 */
@Injectable()
export class MaterialReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
    private readonly finalClose: FinalCloseProbe,
  ) {}

  async receive(request: Request, body: MaterialReturnReceive, actor: MaterialReturnActor, plantId: bigint | null): Promise<MaterialReturnView> {
    assertReceiveBody(body);
    const context = idempotencyContextOf(request, HttpStatus.CREATED);
    const replay = await this.idempotency.replayExisting<MaterialReturnView>(context);
    if (replay !== undefined) return replay.body;
    const preview = await this.plan(this.prisma, body, plantId);
    const plant = preview[0].lot.plantId;
    // 적치 지시 번호는 트랜잭션 «밖»에서 미리 받는다(생산창고 입고 M-01-09 와 같다) — 적치 대기로 받는 줄 수는 본문으로 정해진다.
    const staged = preview.filter((line) => line.staged).length;
    const putawayNos = staged === 0 ? [] : await this.numbering.nextMany('PUTAWAY_TASK', plant, body.businessDate, staged);

    for (let attempt = 0; ; attempt += 1) {
      const no = await this.numbering.next(MATERIAL_RETURN_DOCUMENT, plant, body.businessDate);
      try {
        return (await this.idempotency.run(context, (tx) => this.write(tx, body, actor, plantId, no, putawayNos))).body;
      } catch (error) {
        if (!isDuplicateNo(error) || attempt >= NUMBER_RETRY) throw restricted(error);
      }
    }
  }

  private async write(
    tx: Prisma.TransactionClient, body: MaterialReturnReceive, actor: MaterialReturnActor, plantId: bigint | null, no: string,
    putawayNos: readonly string[],
  ): Promise<MaterialReturnView> {
    const lotIds = [...new Set(body.lines.map((line) => BigInt(line.lotId)))].sort((a, b) => (a < b ? -1 : 1));
    // 같은 LOT 동시 반납은 이 자물쇠로 줄을 서고, 뒤의 것은 아래 재계산의 반납 가능 양에 걸린다.
    await tx.$queryRaw`SELECT lot_id FROM trace.lot WHERE lot_id = ANY(${lotIds}::bigint[]) ORDER BY lot_id FOR NO KEY UPDATE`;
    const lines = await this.plan(tx, body, plantId);
    const occurredAt = new Date(body.occurredAt);

    for (const line of lines.filter((row) => row.addDesignation)) {
      await tx.location_item.createMany({ data: [{ location_id: line.to.locationId, item_id: line.lot.itemId }], skipDuplicates: true });
    }
    const header = await tx.material_return.create({
      data: {
        material_return_no: no, destination_warehouse_id: lines[0].to.warehouseId, status_code: RETURN_RECEIVED,
        requested_at: occurredAt, received_at: occurredAt, business_date: new Date(`${body.businessDate}T00:00:00.000Z`),
        terminal_kind_code: actor.terminalKindCode ?? null, received_by: actor.workerId ?? null,
        created_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
      },
    });
    const posting: PostingLine[] = [];
    const ledgerIndex: number[] = [];
    const lineIds: bigint[] = [];
    for (const [index, line] of lines.entries()) {
      const created = await tx.material_return_line.create({
        data: {
          material_return_id: header.material_return_id, line_no: index + 1, item_id: line.lot.itemId, lot_id: line.lot.lotId,
          return_qty: line.qty, uom_id: line.lot.uomId, work_order_id: line.workOrderId, goods_issue_line_id: line.lot.issue.goodsIssueLineId,
          attribution_code: line.attributionCode, destination_location_id: line.to.locationId,
          created_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
        },
      });
      lineIds.push(created.material_return_line_id);
      ledgerIndex.push(posting.length);
      posting.push(...(await postingLinesOf(tx, line)));
    }
    await createPutawayTasks(tx, lines, lineIds, putawayNos, actor.appUserId);

    const posted = await this.posting.post(tx, {
      businessDate: body.businessDate, occurredAt, transactionTypeCode: MATERIAL_RETURN_DOCUMENT, transactionNo: no, statusCode: 'POSTED',
      plantId: Number(lines[0].lot.plantId), sourceDocumentTypeCode: MATERIAL_RETURN_DOCUMENT, sourceDocumentId: Number(header.material_return_id),
      idempotencyKey: `${MATERIAL_RETURN_DOCUMENT}:${no}`, ...(actor.appUserId === undefined ? {} : { createdBy: actor.appUserId }), lines: posting,
    });
    if (posted.alreadyPosted) throw new Error(`반납 원장이 이미 있다: ${no}`);
    // posting 은 받은 순서대로 line_no 를 매긴다 — 반납 줄마다 그 줄의 첫 원장 라인을 잇는다(receipt-posting 과 같다).
    const ledger = await tx.inventory_transaction_line.findMany({
      where: { inventory_transaction_id: posted.inventoryTransactionId, business_date: new Date(`${body.businessDate}T00:00:00.000Z`) },
      orderBy: { line_no: 'asc' }, select: { inventory_transaction_line_id: true },
    });
    if (ledger.length !== posting.length) throw new Error(`원장 라인 수가 다르다: ${ledger.length} ≠ ${posting.length}`);
    for (const [index, lineId] of lineIds.entries()) {
      await tx.material_return_line.update({
        where: { material_return_line_id: lineId }, data: { inventory_transaction_line_id: ledger[ledgerIndex[index]].inventory_transaction_line_id },
      });
    }
    if (actor.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, { actor: actor.terminalAudit, targetTypeCode: MATERIAL_RETURN_DOCUMENT, targetId: header.material_return_id, eventTypeCode: 'CREATE' });
    }
    const row = await tx.material_return.findUniqueOrThrow({ where: { material_return_id: header.material_return_id }, include: MATERIAL_RETURN_LINE_INCLUDE });
    return materialReturnView(row, await unprintedSplitLotIds(tx, lotIds));
  }

  /** 줄마다 반납 판정·귀속·받는 위치. 막히면 400(줄 자리)·409(미지정 위치 확인)를 한 번에 낸다. */
  private async plan(db: Prisma.TransactionClient | PrismaService, body: MaterialReturnReceive, plantId: bigint | null): Promise<PlannedLine[]> {
    const facts = await loadReturnLots(db, this.finalClose, body.lines.map((line) => BigInt(line.lotId)), plantId);
    const errors: ErrorItem[] = [];
    const planned: PlannedLine[] = [];
    let confirmNeeded: ErrorItem | null = null;
    for (const [index, line] of body.lines.entries()) {
      const at = `lines[${index}]`;
      const lot = facts.get(BigInt(line.lotId));
      if (lot === undefined || lot === 'NOT_FOUND') { errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '없는 LOT 입니다.')); continue; }
      if (lot === 'NOT_RETURNABLE' || lot === 'NOTHING_TO_RETURN') { errors.push(field(`${at}.lotId`, lot, RETURN_MESSAGES[lot])); continue; }
      const qty = new Prisma.Decimal(line.returnQty);
      if (qty.greaterThan(lot.returnable)) {
        errors.push(field(`${at}.returnQty`, ERROR_CODE.RANGE, RETURN_MESSAGES.overReturnable(lot.returnable.toString())));
        continue;
      }
      if (qty.decimalPlaces() > lot.decimalScale) {
        errors.push(field(`${at}.returnQty`, ERROR_CODE.RANGE, `소수 ${lot.decimalScale}자리까지 적을 수 있습니다.`));
        continue;
      }
      // W/O 로 찾기 줄(FR-016) — 고른 W/O 는 그 LOT 의 가장 최근 출고 W/O 여야 한다(자동 귀속과 결과가 같다).
      const picked = line.workOrderId !== undefined && line.workOrderId !== null;
      if (picked && BigInt(line.workOrderId as number) !== lot.issue.workOrderId) {
        errors.push(field(`${at}.workOrderId`, 'WORK_ORDER_MISMATCH', RETURN_MESSAGES.WORK_ORDER_MISMATCH));
        continue;
      }
      const statuses = RECEIPT_STATUS_OF_LOT[lot.statusCode];
      const attribution = attributionOf(lot.issue.workOrderId, lot.finalized, picked);
      const base = { lot, qty, ...attribution };
      if (line.destinationLocationId === undefined || line.destinationLocationId === null) {
        const locationId = await arrivalLocationId(db, lot.issue.sourceWarehouseId);
        planned.push({ ...base, addDesignation: false, staged: true, to: { warehouseId: lot.issue.sourceWarehouseId, locationId, quality: statuses.quality, inventory: statuses.inventory } });
        continue;
      }
      const location = await loadVerdictLocation(db, { locationId: BigInt(line.destinationLocationId) });
      const verdict = verdictOf(location, { plantId: lot.plantId, itemId: lot.itemId, defective: lot.statusCode === 'DEFECTIVE' });
      if (location === null || (verdict !== 'DESIGNATED' && verdict !== 'UNDESIGNATED')) {
        errors.push(field(`${at}.destinationLocationId`, verdict, VERDICT_MESSAGES[verdict]));
        continue;
      }
      if (verdict === 'UNDESIGNATED' && line.confirmUndesignated !== true) {
        confirmNeeded ??= field(`${at}.confirmUndesignated`, 'UNDESIGNATED_NEEDS_CONFIRM', VERDICT_MESSAGES.UNDESIGNATED);
      }
      planned.push({
        ...base, addDesignation: designationAddable(verdict, location), staged: false,
        to: { warehouseId: location.warehouseId, locationId: location.locationId, quality: statuses.quality, inventory: statuses.inventory },
      });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    if (confirmNeeded !== null) throw new ContractException(HttpStatus.CONFLICT, [confirmNeeded]);
    const plants = new Set(planned.map((line) => line.lot.plantId));
    if (plants.size > 1) throw new ContractException(HttpStatus.BAD_REQUEST, [field('lines', ERROR_CODE.INVALID, '한 번에 한 공장의 LOT 만 반납할 수 있습니다.')]);
    return planned;
  }
}

/**
 * 원장 줄 — 받는 위치로 들어오는 입고(`to` 만)다. #362 전 출고분은 귀속 출고 라인의 도착 위치에 그 LOT 재고가 남아 있으면
 * 그 재고(쓸 수 있는 양까지)를 빼서 옮기고, 남는 양만 입고한다(R-3). 옮기는 몫의 상태·소유는 그 잔액 행 그대로다.
 */
async function postingLinesOf(tx: Prisma.TransactionClient, line: PlannedLine): Promise<PostingLine[]> {
  const common = { itemId: Number(line.lot.itemId), lotId: Number(line.lot.lotId), uomId: Number(line.lot.uomId) };
  const to = (quality: string, inventory: string) => ({
    warehouseId: Number(line.to.warehouseId), locationId: Number(line.to.locationId), qualityStatusCode: quality, inventoryStatusCode: inventory,
  });
  const lines: PostingLine[] = [];
  let left = line.qty;
  const floor = line.lot.issue.destinationLocationId;
  if (floor !== null && floor !== line.to.locationId) {
    const held = (await lockBalancesByItemLot(tx, line.lot.itemId, line.lot.lotId))
      .find((row) => row.locationId === floor && new Prisma.Decimal(row.available_qty ?? 0).greaterThan(0));
    if (held !== undefined) {
      const moved = Prisma.Decimal.min(left, new Prisma.Decimal(held.available_qty ?? 0));
      lines.push({
        ...common, qty: moved.toNumber(), ownershipTypeCode: held.ownership_type_code,
        ...(held.owner_partner_id === null ? {} : { ownerPartnerId: Number(held.owner_partner_id) }),
        from: { warehouseId: Number(held.warehouseId), locationId: Number(held.locationId), qualityStatusCode: held.quality_status_code, inventoryStatusCode: held.inventory_status_code },
        to: to(held.quality_status_code, held.inventory_status_code),
      });
      left = left.minus(moved);
    }
  }
  if (left.greaterThan(0)) lines.push({ ...common, qty: left.toNumber(), ownershipTypeCode: OWNED, to: to(line.to.quality, line.to.inventory) });
  return lines;
}

/**
 * 적치 대기로 받은 줄마다 `PENDING` 적치 지시 하나(2026-11-28 사용자 결정) — 생산창고 입고(M-01-09 `createPutawayTasks`)와 같은 모양:
 * 원천 = 반납 줄, 출발 = 적치 대기(받은 위치), 수량 = 반납 수량, 둘 곳은 읽을 때 보관 품목으로 계산, 담당자 없음.
 * PDA 「적치·입고 완료」의 기존 완료 API 가 적치 대기에 남은 그 LOT 만큼 옮긴다(입고 전표가 없는 원천 갈래).
 */
async function createPutawayTasks(
  tx: Prisma.TransactionClient, lines: readonly PlannedLine[], lineIds: readonly bigint[], putawayNos: readonly string[],
  appUserId: number | undefined,
): Promise<void> {
  const staged = lines.flatMap((line, index) => (line.staged ? [{ line, lineId: lineIds[index] }] : []));
  // 번호는 미리 받은 본문 기준 줄 수다 — 잠근 뒤 다시 세운 계획이 달라질 수 없다(위치 유무는 본문이 정한다).
  if (staged.length !== putawayNos.length) throw new Error(`적치 지시 번호 수가 다르다: ${putawayNos.length} ≠ ${staged.length}`);
  for (const [index, { line, lineId }] of staged.entries()) {
    await tx.putaway_task.create({
      data: {
        putaway_task_no: putawayNos[index], material_return_line_id: lineId, item_id: line.lot.itemId, lot_id: line.lot.lotId,
        task_qty: line.qty, uom_id: line.lot.uomId, from_location_id: line.to.locationId, status_code: PUTAWAY_PENDING,
        created_by: appUserId === undefined ? null : BigInt(appUserId),
      },
    });
  }
}

/** 형식 검증 — 업무일·시각, 본문 안 같은 LOT 두 줄(반납 가능 양이 두 벌이 된다). 형·필수·수량 > 0 은 계약 가드가 먼저 본다. */
export function assertReceiveBody(body: MaterialReturnReceive): void {
  const errors: ErrorItem[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate)) errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식입니다.'));
  if (Number.isNaN(Date.parse(body.occurredAt))) errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  const seen = new Set<number>();
  body.lines.forEach((line, index) => {
    if (seen.has(line.lotId)) errors.push(field(`lines[${index}].lotId`, ERROR_CODE.INVALID, '같은 LOT 이 두 줄입니다.'));
    seen.add(line.lotId);
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** 잠금 사이에 「지정 품목만 받기」가 켜져 코어가 거절하면 위치 판정과 같은 코드로 돌려준다(적치 009 와 같다). */
function restricted(error: unknown): unknown {
  if (!(error instanceof ContractException)) return error;
  const items = (error.getResponse() as { errors?: ErrorItem[] }).errors ?? [];
  return items.some((item) => item.code === CORE_RESTRICTED)
    ? new ContractException(HttpStatus.BAD_REQUEST, [field('lines', 'RESTRICTED_LOCATION', VERDICT_MESSAGES.RESTRICTED_LOCATION)])
    : error;
}

function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.some((column) => ['material_return_no', 'transaction_no'].includes(String(column)));
}
