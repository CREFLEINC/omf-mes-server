import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { idempotencyContextOf } from '../../common/master';
import {
  INBOUND_RECEIPT_LINE_SOURCE, INITIAL_LOT_STATUS, LotHoldService, LotLifecycleService, LotQualityStatusService,
  registerMaterialLotsWithin,
} from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { findInspectionPlanVersion, planDefaultSkip } from '../../core/quality/inspection-plan-version';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { assertDay, assertInstant, isDuplicateLotNo } from '../../trace/lot/lot-rules';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { RegisteredLotSummary, recordInboundLotEvent } from './inbound-lot-event';
import { InboundLotCloseService, IqcRequestNoNeeded } from './inbound-lot-close';
import { iqcSkipRecorded } from './inbound-lot-iqc-skip-default';
import { OpenInboundLot, createInboundLotWithin, lockOpenInboundLot } from './inbound-lot-open';
import {
  InboundLotReceiveEntry, ResolvedReceiveLot, assertReceiveEntries, resolveReceiveLots,
} from './inbound-lot-receive-lots';

/** 계약 `InboundLotReceive`. */
export interface InboundLotReceive {
  receiptDatetime: string;
  businessDate: string;
  occurredAt: string;
  deliveryNoteNo?: string | null;
  plantId?: number | null;
  lots: InboundLotReceiveEntry[];
}

export interface InboundLotReceivedView {
  inboundLotId: number;
  inboundLotNo: string;
  created: boolean;
  autoClosedInboundLotNo: string | null;
  /** 검사 불필요 입하 LOT 을 마감하면 IQC 가 「검사 생략」으로 남는가(G2 L15) — 마감 확인 창 문구. */
  iqcDefaultSkipApplies: boolean;
  inboundReceiptNo: string;
  receivedQty: number;
  lotCount: number;
  lots: { lotId: number; lotNo: string; lotQty: number; statusCode: string; fromSupplierLabel: boolean }[];
}

export interface InboundLotReceiveResult {
  inboundLots: InboundLotReceivedView[];
}

/** 새 입하 LOT 을 열 묶음의 번호. 지난 날짜 입하 LOT 을 먼저 자동 마감할 묶음은 IQC 요청 번호도 함께 뽑는다. */
interface Numbers { inboundReceiptNo: string; inboundLotNo: string; iqcRequestNo?: string }
interface ReceiveContext {
  body: InboundLotReceive;
  plantId: bigint;
  localDay: string;
  actor: LogisticsWriteActor;
  numbers: Map<string, Numbers>;
  at: Date;
}

/** 열린 입하 LOT 이 없어 새로 열어야 하는데 미리 뽑은 번호가 없다 — 트랜잭션을 버리고 번호를 뽑아 다시 한다. */
class NumbersNeeded extends Error {}

const MATERIAL_LOT_TYPE = 'MATERIAL';
const SUPPLIER_LOT = 'SUPPLIER_LOT';
const ACTIVE = 'ACTIVE';
const NORMAL = 'NORMAL';
const RETRY = 3;
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/**
 * PDA 입하 받기(M-01-01 · 피처 005 §3 · R-5). 스캔 하나 = 요청 하나 = 멱등 키 하나.
 * ⛔ 채번은 트랜잭션 «밖»이다(`NumberingService.next`) — 새 입하 LOT 이 필요한 묶음만 미리 뽑고, 그 사이 상황이 바뀌면 다시 뽑는다.
 */
@Injectable()
export class InboundLotReceiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: LotLifecycleService,
    private readonly quality: LotQualityStatusService,
    private readonly holds: LotHoldService,
    private readonly closer: InboundLotCloseService,
  ) {}

  async receive(request: Request, body: InboundLotReceive, actor: LogisticsWriteActor, terminalPlantId?: bigint): Promise<InboundLotReceiveResult> {
    const errors: ErrorItem[] = [];
    assertDay('businessDate', body.businessDate, errors);
    assertInstant('occurredAt', body.occurredAt, errors);
    assertInstant('receiptDatetime', body.receiptDatetime, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    assertReceiveEntries(body.lots);
    const context = idempotencyContextOf(request, HttpStatus.CREATED);
    const replay = await this.idempotency.replayExisting<InboundLotReceiveResult>(context);
    if (replay !== undefined) return replay.body;

    const plantId = await this.plantOf(body, terminalPlantId);
    const plant = await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: plantId }, select: { timezone_code: true } });
    const ctx: ReceiveContext = {
      body, plantId, actor, at: new Date(), numbers: new Map(),
      localDay: localDate(new Date(body.occurredAt), plant.timezone_code),
    };
    // 거부(400·409)를 채번 «전»에 낸다 — 같은 판정을 트랜잭션 안에서 잠그고 한 번 더 한다.
    const preview = await resolveReceiveLots(this.prisma as unknown as Prisma.TransactionClient, plantId, body.lots, false);
    const unopened = await this.unopenedGroups(plantId, preview, ctx.localDay);
    ctx.numbers = await this.numbersFor(plantId, unopened.keys, body.businessDate, unopened.stale);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.idempotency.run(context, (tx) => this.receiveWithin(tx, ctx), TRANSACTION_OPTIONS);
        return outcome.body;
      } catch (error) {
        const numbersNeeded = error instanceof NumbersNeeded || error instanceof IqcRequestNoNeeded;
        if (attempt >= RETRY || !(numbersNeeded || isDuplicateLotNo(error))) throw error;
        if (numbersNeeded) {
          // 그사이 열리거나 닫힌 입하 LOT 을 다시 본다 — 필요한 묶음에만 번호를 뽑아 결번을 줄인다.
          const again = await this.unopenedGroups(plantId, preview, ctx.localDay);
          ctx.numbers = await this.numbersFor(plantId, again.keys, body.businessDate, again.stale);
        }
      }
    }
  }

  /** 단말은 단말 공장. 계정은 본문 `plantId`, 없으면 `lotId` LOT 들의 공장(하나여야 한다). */
  private async plantOf(body: InboundLotReceive, terminalPlantId?: bigint): Promise<bigint> {
    if (terminalPlantId !== undefined) return terminalPlantId;
    if (body.plantId !== undefined && body.plantId !== null) return BigInt(body.plantId);
    const ids = body.lots.flatMap((entry) => (entry.lotId === undefined ? [] : [BigInt(entry.lotId)]));
    const plants = await this.prisma.lot.findMany({ where: { lot_id: { in: ids } }, select: { plant_id: true }, distinct: ['plant_id'] });
    if (plants.length === 1 && ids.length === body.lots.length) return plants[0].plant_id;
    throw new ContractException(HttpStatus.BAD_REQUEST, [plants.length > 1
      ? field('lots', ERROR_CODE.INVALID, '공장이 다른 LOT 이 섞여 있습니다.')
      : field('plantId', ERROR_CODE.INVALID, '공장을 정할 수 없습니다 — plantId 를 보내세요.')]);
  }

  /** 새로 열 묶음 — 열린 입하 LOT 이 없거나, 있어도 지난 날짜라 먼저 자동 마감할 것(`stale`). */
  private async unopenedGroups(plantId: bigint, lots: ResolvedReceiveLot[], today: string): Promise<{ keys: string[]; stale: Set<string> }> {
    const keys = groupKeys(lots);
    const open = await this.prisma.inbound_lot.findMany({
      where: { plant_id: plantId, status_code: 'RECEIVING', OR: keys.map((key) => keyWhere(key)) },
      select: { supplier_id: true, item_id: true, open_since_date: true },
    });
    const keyOf = (row: { supplier_id: bigint; item_id: bigint }): string => `${String(row.supplier_id)}:${String(row.item_id)}`;
    const stale = new Set(open.filter((row) => isStale(row.open_since_date?.toISOString().slice(0, 10) ?? today, today)).map(keyOf));
    const fresh = new Set(open.map(keyOf).filter((key) => !stale.has(key)));
    return { keys: keys.filter((key) => !fresh.has(key)), stale };
  }

  private async numbersFor(plantId: bigint, keys: string[], businessDate: string, stale: Set<string>): Promise<Map<string, Numbers>> {
    const numbers = new Map<string, Numbers>();
    for (const key of keys) {
      numbers.set(key, {
        inboundReceiptNo: await this.numbering.next('INBOUND_RECEIPT', plantId, businessDate),
        inboundLotNo: await this.numbering.next('INBOUND_LOT', plantId, businessDate),
        ...(stale.has(key) ? { iqcRequestNo: await this.numbering.next('INSPECTION_REQUEST', plantId, businessDate) } : {}),
      });
    }
    return numbers;
  }

  private async receiveWithin(tx: Prisma.TransactionClient, ctx: ReceiveContext): Promise<InboundLotReceiveResult> {
    const lots = await resolveReceiveLots(tx, ctx.plantId, ctx.body.lots, true);
    const groups = new Map<string, ResolvedReceiveLot[]>();
    for (const lot of lots) {
      const key = `${String(lot.supplierId)}:${String(lot.itemId)}`;
      groups.set(key, [...(groups.get(key) ?? []), lot]);
    }
    // 교착을 피하려 (공급사 id, 품목 id) 순으로 잠근다 — 응답은 본문에 처음 나온 순서다.
    const ordered = [...groups.entries()].sort(([, left], [, right]) => compareKey(left[0], right[0]));
    const results: { first: number; view: InboundLotReceivedView }[] = [];
    for (const [key, group] of ordered) {
      results.push({ first: group[0].index, view: await this.receiveGroup(tx, ctx, key, group) });
    }
    return { inboundLots: results.sort((left, right) => left.first - right.first).map((result) => result.view) };
  }

  private async receiveGroup(
    tx: Prisma.TransactionClient, ctx: ReceiveContext, key: string, group: ResolvedReceiveLot[],
  ): Promise<InboundLotReceivedView> {
    const lotKey = { plantId: ctx.plantId, supplierId: group[0].supplierId, itemId: group[0].itemId };
    const qty = group.reduce((sum, lot) => sum.plus(lot.qty), new Prisma.Decimal(0));
    const item = await tx.item.findUniqueOrThrow({ where: { item_id: lotKey.itemId }, select: { base_uom_id: true, inspection_required: true } });
    let open = await lockOpenInboundLot(tx, lotKey);
    let autoClosedInboundLotNo: string | null = null;
    if (open !== null && isStale(open.openSinceDate, ctx.localDay)) {
      // 지난 날짜(공장 현지)에 연 입하 LOT — 같은 트랜잭션에서 시스템이 먼저 마감하고 새로 연다(R-21).
      await this.closer.closeInboundLot(tx, {
        inboundLotId: open.inboundLotId, actor: null, auto: true, at: ctx.at, effectiveDate: ctx.localDay,
        iqcRequestNo: ctx.numbers.get(key)?.iqcRequestNo ?? null,
      });
      autoClosedInboundLotNo = open.inboundLotNo;
      open = null;
    }
    let created = false;
    for (let attempt = 1; open === null; attempt += 1) {
      const numbers = ctx.numbers.get(key);
      if (numbers === undefined) throw new NumbersNeeded();
      if (attempt > RETRY) throw new ConflictException('workerLease', '같은 공급사·품목의 입하 LOT 을 여는 중입니다. 다시 스캔하세요.');
      open = await createInboundLotWithin(tx, {
        key: lotKey, ...numbers, uomId: item.base_uom_id, receivedQty: qty,
        inspectionNeeded: await inspectionNeeded(tx, lotKey.itemId, item.inspection_required, ctx.body.businessDate),
        receiptDatetime: ctx.body.receiptDatetime, deliveryNoteNo: ctx.body.deliveryNoteNo ?? null,
        localDay: ctx.localDay, actor: ctx.actor,
      });
      created = open !== null;
      open ??= await lockOpenInboundLot(tx, lotKey);
    }
    const line = await this.attach(tx, ctx, open, created, qty);
    const createdLotIds = await this.createLabelLots(tx, ctx, open, item.base_uom_id, group);
    await registerMaterialLotsWithin(tx, { lifecycle: this.lifecycle, quality: this.quality, holds: this.holds }, {
      inboundLotId: open.inboundLotId, inboundReceiptLineId: open.inboundReceiptLineId,
      waitingLotIds: group.flatMap((lot) => (lot.kind === 'waiting' ? [lot.lotId] : [])),
      createdLotIds: [...createdLotIds.values()], inspectionNeeded: line.inspection_required, actor: ctx.actor, at: ctx.at,
    });
    const lotIdOf = (lot: ResolvedReceiveLot): bigint => (lot.kind === 'waiting' ? lot.lotId : createdLotIds.get(lot.index) as bigint);
    await this.recordEvents(tx, ctx, open, created, line.inbound_receipt.inbound_receipt_no, group.map((lot): RegisteredLotSummary => ({
      lotId: String(lotIdOf(lot)), lotNo: lot.lotNo, lotQty: lot.qty.toString(),
      batchId: lot.kind === 'waiting' ? String(lot.batchId) : null, fromSupplierLabel: lot.kind === 'label',
    })));
    const statusCode = line.inspection_required ? INITIAL_LOT_STATUS : NORMAL;
    return {
      inboundLotId: Number(open.inboundLotId), inboundLotNo: open.inboundLotNo, created, autoClosedInboundLotNo,
      iqcDefaultSkipApplies: !line.inspection_required && (await iqcSkipRecorded(tx, lotKey.itemId, ctx.localDay)),
      inboundReceiptNo: line.inbound_receipt.inbound_receipt_no, receivedQty: Number(line.received_qty),
      lotCount: await tx.lot.count({ where: { inbound_lot_id: open.inboundLotId } }),
      lots: group.map((lot) => ({
        lotId: Number(lotIdOf(lot)), lotNo: lot.lotNo, lotQty: Number(lot.qty), statusCode, fromSupplierLabel: lot.kind === 'label',
      })),
    };
  }

  /** 붙는 받기면 줄 수량을 늘리고 입하 LOT 버전을 올린다(새로 연 것은 이미 그 수량으로 섰다). */
  private async attach(tx: Prisma.TransactionClient, ctx: ReceiveContext, open: OpenInboundLot, created: boolean, qty: Prisma.Decimal) {
    const by = ctx.actor.appUserId === undefined ? null : BigInt(ctx.actor.appUserId);
    if (!created) {
      await tx.inbound_receipt_line.update({
        where: { inbound_receipt_line_id: open.inboundReceiptLineId },
        data: { received_qty: { increment: qty }, updated_by: by },
      });
      await tx.inbound_lot.update({
        where: { inbound_lot_id: open.inboundLotId }, data: { version_no: { increment: 1 }, updated_by: by },
      });
    }
    return tx.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: open.inboundReceiptLineId },
      select: { received_qty: true, inspection_required: true, inbound_receipt: { select: { inbound_receipt_no: true } } },
    });
  }

  /** 시스템에 없는 사전부착 라벨 — 바로 ACTIVE 로 세운다(생애 전이가 아니라 태어남). 라벨의 공급사 LOT 번호를 붙인다. */
  private async createLabelLots(
    tx: Prisma.TransactionClient, ctx: ReceiveContext, open: OpenInboundLot, uomId: bigint, group: ResolvedReceiveLot[],
  ): Promise<Map<number, bigint>> {
    const by = ctx.actor.appUserId === undefined ? null : BigInt(ctx.actor.appUserId);
    const created = new Map<number, bigint>();
    for (const lot of group) {
      if (lot.kind !== 'label') continue;
      const row = await tx.lot.create({
        data: {
          lot_no: lot.lotNo, item_id: lot.itemId, lot_type_code: MATERIAL_LOT_TYPE, plant_id: ctx.plantId,
          initial_qty: lot.qty, uom_id: uomId, source_type_code: INBOUND_RECEIPT_LINE_SOURCE,
          source_id: open.inboundReceiptLineId, inbound_lot_id: open.inboundLotId,
          status_code: INITIAL_LOT_STATUS, lifecycle_status_code: ACTIVE, created_by: by,
        },
        select: { lot_id: true },
      });
      if (lot.supplierLotNo !== null) {
        await tx.lot_external_identifier.create({
          data: { lot_id: row.lot_id, identifier_type_code: SUPPLIER_LOT, external_identifier: lot.supplierLotNo,
            partner_id: lot.supplierId, created_by: by },
        });
      }
      created.set(lot.index, row.lot_id);
    }
    return created;
  }

  private async recordEvents(
    tx: Prisma.TransactionClient, ctx: ReceiveContext, open: OpenInboundLot, created: boolean,
    inboundReceiptNo: string, lots: RegisteredLotSummary[],
  ): Promise<void> {
    const deliveryNoteNo = ctx.body.deliveryNoteNo ?? null;
    if (created) await recordInboundLotEvent(tx, open.inboundLotId, 'CREATED_BY_RECEIVE', ctx.actor, { inboundReceiptNo, deliveryNoteNo }, ctx.at);
    await recordInboundLotEvent(tx, open.inboundLotId, 'LOTS_REGISTERED', ctx.actor,
      { lots: lots as unknown as Prisma.InputJsonArray, deliveryNoteNo }, ctx.at);
    if (ctx.actor.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, {
        actor: ctx.actor.terminalAudit, targetTypeCode: 'INBOUND_LOT', targetId: open.inboundLotId, eventTypeCode: 'LOTS_REGISTERED',
      });
    }
  }
}

/** 품목이 수입검사 대상이고 그날의 IQC 기준이 「기본 생략」이 아니면 검사가 필요하다(입하 LOT 이 생길 때 한 번 정한다). */
async function inspectionNeeded(tx: Prisma.TransactionClient, itemId: bigint, required: boolean, businessDate: string): Promise<boolean> {
  if (!required) return false;
  const version = await findInspectionPlanVersion(tx, 'IQC', Number(itemId), businessDate);
  return version === null || !(await planDefaultSkip(tx, version));
}

/** 입하 중이 된 날(`open_since_date`)이 공장 현지 오늘보다 앞이면 날짜 자동 마감 대상이다(R-21). */
function isStale(openSinceDate: string, today: string): boolean {
  return openSinceDate < today;
}

function groupKeys(lots: ResolvedReceiveLot[]): string[] {
  return [...new Set(lots.map((lot) => `${String(lot.supplierId)}:${String(lot.itemId)}`))];
}

function keyWhere(key: string): Prisma.inbound_lotWhereInput {
  const [supplierId, itemId] = key.split(':').map((part) => BigInt(part));
  return { supplier_id: supplierId, item_id: itemId };
}

function compareKey(left: ResolvedReceiveLot, right: ResolvedReceiveLot): number {
  if (left.supplierId !== right.supplierId) return left.supplierId < right.supplierId ? -1 : 1;
  if (left.itemId === right.itemId) return 0;
  return left.itemId < right.itemId ? -1 : 1;
}
