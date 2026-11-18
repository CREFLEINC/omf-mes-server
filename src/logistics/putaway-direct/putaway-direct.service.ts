import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ContractException, ErrorItem } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { WAREHOUSE_WHOLE, idempotencyContextOf } from '../../common/master';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { IF_GOODS_RECEIPT, OutboxService, outboxMessageKey } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { MATERIAL_RECEIPT } from '../goods-receipt/erp-receipt';
import { assertInboundLotsWithin, erpLinesOf } from '../goods-receipt/receipt-gate';
import { RECEIPT_STATUS_OF_LOT } from '../goods-receipt/receipt-defaults.service';
import { GoodsReceiptCreate, postReceipt } from '../goods-receipt/receipt-posting';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { VERDICT_MESSAGES, VerdictCode, VerdictLocation, defectRuleVerdict, loadVerdictLocation, locationPaths, verdictOf } from './location-verdict';
import { PendingLotFacts } from './pending-lot-query';
import { PutawayDirectQueryService } from './putaway-direct.query.service';

export interface PutawayDirectBody { locationId: number; confirmUndesignated?: boolean; businessDate: string; occurredAt: string }
export interface PutawayTemporaryBody { warehouseId: number; businessDate: string; occurredAt: string }

export type PutawayModeCode = 'DESIGNATED' | 'UNDESIGNATED' | 'TEMPORARY';

export interface PutawayDirectResult {
  goodsReceiptId: number; goodsReceiptNo: string; lotId: number; lotNo: string; qty: number; uomCode: string;
  warehouseId: number; warehouseName: string; locationId: number; locationCode: string; locationPath: string;
  putawayModeCode: PutawayModeCode; itemDesignationAdded: boolean;
}

/** 어디에 어떻게 — 적치는 스캔한 위치, 임시 적치는 고른 창고의 「창고 전체」. */
type Target = { kind: 'location'; locationId: bigint; confirmUndesignated: boolean } | { kind: 'warehouse'; warehouseId: bigint };

const NUMBER_RETRY = 3;
const GOODS_RECEIPT_TARGET = 'GOODS_RECEIPT';
const SOURCE_DOCUMENT = 'INBOUND_RECEIPT';
/** 코어가 「지정 품목만 받기」 위치에서 거절한 코드(S7) — PDA 가 같은 알림을 보이게 판정 코드로 바꾼다. */
const CORE_RESTRICTED = 'LOCATION_ITEM_RESTRICTED';

/**
 * 적치 지시 없는 구매 입고 적치(피처 009 research R-1·R-7·R-10, contracts §4·§5) — LOT 하나를 잠그고 적치 대기 조건과
 * 위치 판정을 다시 본 뒤 입고 1건·라인 1줄을 적치 지시 없이(`putawayNos = null`) 전기한다. 재고는 적치 대기 자리를 거치지 않고
 * 스캔한 위치(임시 적치면 그 창고 「창고 전체」)로 바로 들어간다. 수량은 받지 않는다 — 입고 가능 수량 전부다.
 */
@Injectable()
export class PutawayDirectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    private readonly queries: PutawayDirectQueryService,
  ) {}

  putaway(request: Request, lotId: number, body: PutawayDirectBody, actor: LogisticsWriteActor, plantId: bigint | null): Promise<PutawayDirectResult> {
    const target: Target = { kind: 'location', locationId: BigInt(body.locationId), confirmUndesignated: body.confirmUndesignated === true };
    return this.write(request, BigInt(lotId), body, target, actor, plantId);
  }

  putawayTemporary(request: Request, lotId: number, body: PutawayTemporaryBody, actor: LogisticsWriteActor, plantId: bigint | null): Promise<PutawayDirectResult> {
    return this.write(request, BigInt(lotId), body, { kind: 'warehouse', warehouseId: BigInt(body.warehouseId) }, actor, plantId);
  }

  private async write(
    request: Request, lotId: bigint, body: { businessDate: string; occurredAt: string }, target: Target, actor: LogisticsWriteActor, plantId: bigint | null,
  ): Promise<PutawayDirectResult> {
    assertTimes(body);
    const context = idempotencyContextOf(request, HttpStatus.CREATED);
    const replay = await this.idempotency.replayExisting<PutawayDirectResult>(context);
    if (replay !== undefined) return replay.body;
    // 거절(400·409)을 채번 «전»에 낸다 — 같은 판정을 LOT 을 잠근 뒤 한 번 더 한다.
    const preview = await this.queries.pendingFacts(plantId, lotId);
    await this.resolve(this.prisma, preview, target);

    for (let attempt = 0; ; attempt += 1) {
      const receiptNo = await this.numbering.next('GOODS_RECEIPT', preview.plantId, body.businessDate);
      try {
        const outcome = await this.idempotency.run(context, (tx) => this.post(tx, lotId, body, target, actor, plantId, receiptNo));
        return outcome.body;
      } catch (error) {
        if (!isDuplicateNo(error) || attempt >= NUMBER_RETRY) throw restricted(error);
      }
    }
  }

  private async post(
    tx: Prisma.TransactionClient, lotId: bigint, body: { businessDate: string; occurredAt: string }, target: Target,
    actor: LogisticsWriteActor, plantId: bigint | null, receiptNo: string,
  ): Promise<PutawayDirectResult> {
    // 동시 적치는 LOT 잠금으로 줄을 서고, 뒤의 것은 아래 조건 (d) 에 걸려 409 ALREADY_PUT_AWAY 다(FR-030).
    await tx.$queryRaw`SELECT lot_id FROM trace.lot WHERE lot_id = ${lotId}::bigint FOR NO KEY UPDATE`;
    const facts = await this.queries.pendingFacts(plantId, lotId, tx as unknown as PrismaService);
    const { location, mode } = await this.resolve(tx, facts, target);

    // 미지정 위치 적치는 전기 «전»에 보관 품목을 더한다(FR-017a) — 시스템 자리·임시 적치는 더하지 않는다.
    let itemDesignationAdded = false;
    if (mode === 'UNDESIGNATED' && location.systemRoleCode === null) {
      itemDesignationAdded = (await tx.location_item.createMany({
        data: [{ location_id: location.locationId, item_id: facts.itemId }], skipDuplicates: true,
      })).count > 0;
      if (itemDesignationAdded && actor.terminalAudit !== undefined) {
        await recordTerminalWorkerAudit(tx, { actor: actor.terminalAudit, targetTypeCode: 'LOCATION_ITEM', targetId: location.locationId, eventTypeCode: 'ITEM_ADDED' });
      }
    }

    const input = await this.receiptInput(tx, facts, location, mode, body);
    await assertInboundLotsWithin(tx, input);
    const id = await postReceipt(tx, this.posting, input, actor.appUserId, receiptNo, null);
    if ((await erpLinesOf(tx, input)).length > 0) {
      await this.outbox.enqueue(tx, {
        interfaceCode: IF_GOODS_RECEIPT, messageKey: outboxMessageKey(IF_GOODS_RECEIPT, receiptNo),
        targetTypeCode: GOODS_RECEIPT_TARGET, targetId: id, payload: { goodsReceiptNo: receiptNo },
      });
    }
    if (actor.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, { actor: actor.terminalAudit, targetTypeCode: GOODS_RECEIPT_TARGET, targetId: id, eventTypeCode: 'CREATE' });
    }
    const path = (await locationPaths(tx, [location.locationId])).get(location.locationId) ?? location.locationCode;
    return {
      goodsReceiptId: Number(id), goodsReceiptNo: receiptNo, lotId: Number(facts.lotId), lotNo: facts.lotNo,
      qty: facts.receivableQty.toNumber(), uomCode: facts.uomCode, warehouseId: Number(location.warehouseId), warehouseName: location.warehouseName,
      locationId: Number(location.locationId), locationCode: location.locationCode, locationPath: path, putawayModeCode: mode, itemDesignationAdded,
    };
  }

  /** 위치(또는 창고의 「창고 전체」)와 적치 방식. 막히면 400(판정 코드), 미지정인데 확인이 없으면 409. */
  private async resolve(db: Prisma.TransactionClient | PrismaService, facts: PendingLotFacts, target: Target): Promise<{ location: VerdictLocation; mode: PutawayModeCode }> {
    const lot = { plantId: facts.plantId, itemId: facts.itemId, defective: facts.statusCode === 'DEFECTIVE' };
    if (target.kind === 'warehouse') {
      const whole = await db.location.findFirst({ where: { warehouse_id: target.warehouseId, system_role_code: WAREHOUSE_WHOLE }, select: { location_id: true } });
      const location = whole === null ? null : await loadVerdictLocation(db, { locationId: whole.location_id });
      // 창고 판정은 1~3·6·7 만 본다(R-7) — 위치 판정 8~10 은 없다.
      const verdict = location === null ? 'NOT_FOUND'
        : !location.isActive || !location.warehouseActive ? 'INACTIVE'
          : location.warehousePlantId !== lot.plantId ? 'OTHER_PLANT' : defectRuleVerdict(location.isDefect, lot.defective);
      if (verdict !== null) throw rejected(verdict, 'warehouseId');
      return { location: location as VerdictLocation, mode: 'TEMPORARY' };
    }
    const location = await loadVerdictLocation(db, { locationId: target.locationId });
    const verdict = verdictOf(location, lot);
    if (verdict === 'DESIGNATED') return { location: location as VerdictLocation, mode: 'DESIGNATED' };
    if (verdict !== 'UNDESIGNATED') throw rejected(verdict, 'locationId');
    if (!target.confirmUndesignated) {
      throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'field', field: 'confirmUndesignated', code: 'UNDESIGNATED_NEEDS_CONFIRM', message: VERDICT_MESSAGES.UNDESIGNATED }]);
    }
    return { location: location as VerdictLocation, mode: 'UNDESIGNATED' };
  }

  private async receiptInput(
    tx: Prisma.TransactionClient, facts: PendingLotFacts, location: VerdictLocation, mode: PutawayModeCode, body: { businessDate: string; occurredAt: string },
  ): Promise<GoodsReceiptCreate> {
    const inbound = await tx.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: facts.inboundLineId as bigint }, select: { inbound_receipt_id: true },
    });
    const statuses = RECEIPT_STATUS_OF_LOT[facts.statusCode];
    return {
      receiptTypeCode: MATERIAL_RECEIPT, plantId: Number(facts.plantId), warehouseId: Number(location.warehouseId),
      receiptDatetime: body.occurredAt, sourceDocumentTypeCode: SOURCE_DOCUMENT, sourceDocumentId: Number(inbound.inbound_receipt_id),
      businessDate: body.businessDate,
      lines: [{
        inboundReceiptLineId: Number(facts.inboundLineId), itemId: Number(facts.itemId), lotId: Number(facts.lotId),
        receiptQty: facts.receivableQty.toNumber(), uomId: Number(facts.uomId),
        qualityStatusCode: statuses.quality, inventoryStatusCode: statuses.inventory,
        destinationLocationId: Number(location.locationId), putawayModeCode: mode,
      }],
    };
  }
}

function rejected(verdict: VerdictCode, field: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field, code: verdict, message: VERDICT_MESSAGES[verdict] }]);
}

/** 잠금 사이에 옵션이 켜져 코어가 거절하면(대기열 기록 포함) 판정과 같은 코드로 돌려준다(FR-017d). */
function restricted(error: unknown): unknown {
  if (!(error instanceof ContractException)) return error;
  const items = (error.getResponse() as { errors?: ErrorItem[] }).errors ?? [];
  return items.some((item) => item.code === CORE_RESTRICTED) ? rejected('RESTRICTED_LOCATION', 'locationId') : error;
}

function assertTimes(body: { businessDate: string; occurredAt: string }): void {
  const errors: ErrorItem[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate)) errors.push({ scope: 'field', field: 'businessDate', code: 'INVALID', message: 'YYYY-MM-DD 형식입니다.' });
  if (Number.isNaN(Date.parse(body.occurredAt))) errors.push({ scope: 'field', field: 'occurredAt', code: 'INVALID', message: '시각 형식이 아닙니다.' });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.some((column) => ['goods_receipt_no', 'transaction_no'].includes(String(column)));
}
