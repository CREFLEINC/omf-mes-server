import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { IF_SHIPMENT_PGI, OutboxService, outboxMessageKey } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { completeShipmentOqcWithin } from '../../quality/inspection/oqc-completion';
import type { LogisticsWriteActor } from '../logistics-write-actor';
import { CompletionBlocker } from './shipment-completion-rules';
import { completionPortions, postCompletionIssues, warehousesOf, writeCompletionLines } from './shipment-completion-posting';
import { ShipmentRequestCompletionView, completionView } from './shipment-completion-view';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { SHIPMENT_REQUEST_CODE_PREFIX } from './shipment-request-view';

export const COMPLETION_CONFLICT = {
  COMPLETION_BLOCKED: 'COMPLETION_BLOCKED',
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
} as const;

/** 계약 `ShipmentCompletion` — 본문의 영업일·시각(C-8: 서버가 수신 시각으로 다시 잡지 않는다). */
export interface ShipmentCompletionBody {
  businessDate: string;
  occurredAt?: string;
}

export interface ShipmentCompletionResult {
  shipmentId: number;
  shipmentNo: string;
  completedAt: string;
  completion: ShipmentRequestCompletionView;
}

/**
 * 출하 완료(POP P-04-07 · 피처 010 R-8·R-9) — 지시서 코드 해석(`:lookup`)과 완료(`:complete`).
 * ⭐ 완료 한 번이 한 트랜잭션에서: 관문(FR-016) → 출하 «하나»(CONFIRMED 로 바로, 창고 없음, 완료 단말·작업자) → 창고마다 내부
 *    재고 차감 기록 + 원장 출고 → 출하 라인·LOT 배분 → 지시·수주 출하 수량 → 피킹 LOT SHIPPED → OQC 확정 → 수주 라인이 있으면 ERP 송신 적재.
 * ⭐ 동시 완료는 지시서 헤더 `FOR UPDATE` 로 줄 세우고, 둘째는 「이미 출하 완료」(부분 유일 인덱스가 마지막 그물).
 */
@Injectable()
export class ShipmentCompletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly qualities: LotQualityStatusService,
    private readonly outbox: OutboxService,
    private readonly queries: ShipmentRequestQueryService,
  ) {}

  /** `SHPREQ:{no}` → 완료 확인 값. 단말이면 그 공장 지시서만 — 남의 공장은 「찾을 수 없다」. ERP 송신 여부는 싣지 않는다. */
  async lookup(code: string | undefined, plantId?: bigint): Promise<ShipmentRequestCompletionView> {
    const value = (code ?? '').trim();
    if (!value.startsWith(SHIPMENT_REQUEST_CODE_PREFIX) || value.length === SHIPMENT_REQUEST_CODE_PREFIX.length) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('code', 'NOT_SHIPMENT_REQUEST_CODE', '출하 지시서 코드가 아닙니다.'),
      ]);
    }
    const found = await this.prisma.shipment_request.findFirst({
      where: {
        shipment_request_no: value.slice(SHIPMENT_REQUEST_CODE_PREFIX.length),
        ...(plantId === undefined ? {} : { fulfillment_plant_id: plantId }),
      },
      select: { shipment_request_id: true },
    });
    if (found === null) {
      throw new ContractException(HttpStatus.NOT_FOUND, [
        { scope: 'screen', code: 'SHIPMENT_REQUEST_NOT_FOUND', message: '찾을 수 없는 출하 지시서입니다.' },
      ]);
    }
    return this.view(found.shipment_request_id);
  }

  async view(shipmentRequestId: bigint): Promise<ShipmentRequestCompletionView> {
    return completionView(this.prisma, await this.queries.get(Number(shipmentRequestId)));
  }

  async complete(
    shipmentRequestId: number,
    body: ShipmentCompletionBody,
    version: number | undefined,
    actor: LogisticsWriteActor,
  ): Promise<ShipmentCompletionResult> {
    if (actor.terminalAudit === undefined || actor.workerId === undefined) {
      throw new ContractException(HttpStatus.FORBIDDEN, [
        { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '출하 완료는 POP 단말에서만 합니다.' },
      ]);
    }
    assertBusinessDate(body);
    const audit = actor.terminalAudit;
    const workerId = actor.workerId;
    const id = BigInt(shipmentRequestId);
    const occurredAt = body.occurredAt === undefined ? new Date() : new Date(body.occurredAt);
    const header = await this.prisma.shipment_request.findUnique({ where: { shipment_request_id: id }, select: { fulfillment_plant_id: true } });
    if (header === null) throw new NotFoundException('없는 출하작업지시입니다.');
    // ⛔ 채번은 트랜잭션 «밖»이다(P2024). 창고 수는 지금 피킹으로 정하고, 안에서 달라졌으면 다시 시도하게 한다.
    const plannedWarehouses = warehousesOf(await completionPortions(this.prisma, id));
    const [shipmentNo, ...issueNos] = await Promise.all([
      this.numbering.next('SHIPMENT', header.fulfillment_plant_id, body.businessDate),
      ...plannedWarehouses.map(() => this.numbering.next('GOODS_ISSUE', header.fulfillment_plant_id, body.businessDate)),
    ]);
    const goodsIssueNos = new Map(plannedWarehouses.map((warehouseId, index) => [String(warehouseId), issueNos[index]]));

    const shipmentId = await this.prisma.$transaction(async (tx) => {
      const locked = await lockRequest(tx, id);
      if (version !== undefined && locked.version_no !== version) {
        throw new ConflictException('user', '다른 곳에서 지시서가 바뀌었습니다. 다시 확인하세요.', {
          code: 'VERSION_CONFLICT', currentVersion: String(locked.version_no),
        });
      }
      // 이 지시서의 출하 OQC 의뢰도 잠근다 — 확인과 커밋 사이에 결과가 끼어들지 못하게(결과 쓰기가 의뢰를 잠근다).
      await tx.$queryRaw`
        SELECT inspection_request_id FROM quality.inspection_request
         WHERE inspection_type_code = 'OQC' AND target_type_code = 'SHIPMENT_REQUEST' AND target_id = ${id}
         ORDER BY inspection_request_id FOR UPDATE`;
      const before = await this.queries.getWithin(tx, id);
      assertCompletable(before.completionBlockers);
      const portions = await completionPortions(tx, id);
      const warehouses = warehousesOf(portions);
      if (warehouses.length !== plannedWarehouses.length || warehouses.some((warehouseId) => !goodsIssueNos.has(String(warehouseId)))) {
        throw new ConflictException('user', '피킹이 방금 바뀌었습니다. 다시 확인한 뒤 완료하세요.', { code: 'INVALID_STATE' });
      }
      const now = new Date();
      const shipment = await tx.shipment.create({
        data: {
          shipment_no: shipmentNo, shipment_request_id: id, warehouse_id: null, status_code: 'CONFIRMED',
          shipped_at: occurredAt, confirmed_at: now, completed_terminal_id: audit.terminalId, completed_worker_id: workerId,
        },
        select: { shipment_id: true },
      });
      const issueLineIds = await postCompletionIssues(tx, this.posting, {
        shipmentId: shipment.shipment_id, portions, goodsIssueNos, businessDate: body.businessDate, occurredAt,
      });
      await writeCompletionLines(tx, { shipmentId: shipment.shipment_id, portions, issueLineIds });
      await tx.shipment_request_lot.updateMany({
        where: { status_code: 'PICKED', shipment_request_line: { shipment_request_id: id } },
        data: { status_code: 'SHIPPED', shipment_id: shipment.shipment_id, updated_at: now, version_no: { increment: 1 } },
      });
      await completeShipmentOqcWithin(tx, this.qualities, {
        shipmentRequestId: id,
        lots: (before.lines ?? []).filter((line) => line.shippingInspectionRequired)
          .flatMap((line) => line.lots.filter((lot) => lot.statusCode === 'PICKED').map((lot) => ({ lotId: BigInt(lot.lotId), itemId: BigInt(line.itemId) }))),
        at: now,
        actor: { changedWorkerId: workerId },
      });
      await this.enqueueErpSend(tx, shipment.shipment_id, shipmentNo, id, occurredAt);
      await recordTerminalWorkerAudit(tx, { actor: audit, targetTypeCode: 'SHIPMENT', targetId: shipment.shipment_id, eventTypeCode: 'COMPLETE' });
      return shipment.shipment_id;
    }).catch((error: unknown) => {
      // 마지막 그물 — 헤더 잠금을 비켜 간 동시 완료는 부분 유일 인덱스가 막는다.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw alreadyCompleted();
      throw error;
    });

    return { shipmentId: Number(shipmentId), shipmentNo, completedAt: occurredAt.toISOString(), completion: await this.view(id) };
  }

  /** 수주 연결 라인이 하나라도 있으면 적재한다 — 수주 없는 라인은 빌더가 뺀다(R-11). 모두 수주 없으면 적재하지 않는다. */
  private async enqueueErpSend(tx: Prisma.TransactionClient, shipmentId: bigint, shipmentNo: string, requestId: bigint, shippedAt: Date): Promise<void> {
    const lines = await tx.shipment_line.findMany({
      where: { shipment_id: shipmentId },
      orderBy: { line_no: 'asc' },
      include: { shipment_lot_allocation: { orderBy: { shipment_lot_allocation_id: 'asc' } }, shipment_request_line: { select: { sales_order_line_id: true } } },
    });
    if (!lines.some((line) => line.shipment_request_line.sales_order_line_id !== null)) return;
    await this.outbox.enqueue(tx, {
      interfaceCode: IF_SHIPMENT_PGI,
      messageKey: outboxMessageKey(IF_SHIPMENT_PGI, shipmentNo),
      targetTypeCode: 'SHIPMENT',
      targetId: shipmentId,
      payload: {
        shipmentNo, shipmentRequestId: Number(requestId), warehouseId: null, shippedAt: shippedAt.toISOString(),
        lines: lines.map((line) => ({
          itemId: Number(line.item_id), shippedQty: Number(line.shipped_qty), uomId: Number(line.uom_id),
          allocations: line.shipment_lot_allocation.map((allocation) => ({ lotId: Number(allocation.lot_id), allocatedQty: Number(allocation.allocated_qty) })),
        })),
      },
    });
  }
}

async function lockRequest(tx: Prisma.TransactionClient, id: bigint): Promise<{ version_no: number }> {
  const [row] = await tx.$queryRaw<{ version_no: number }[]>`
    SELECT version_no FROM logistics.shipment_request WHERE shipment_request_id = ${id} FOR UPDATE`;
  if (row === undefined) throw new NotFoundException('없는 출하작업지시입니다.');
  return row;
}

function assertCompletable(blockers: readonly CompletionBlocker[]): void {
  if (blockers.length === 0) return;
  if (blockers.some((blocker) => blocker.code === 'ALREADY_COMPLETED')) throw alreadyCompleted();
  throw new ConflictException('user', '출하를 완료할 수 없습니다 — 막는 이유를 확인하세요.', {
    code: COMPLETION_CONFLICT.COMPLETION_BLOCKED, blockers: [...blockers],
  });
}

function alreadyCompleted(): ConflictException {
  return new ConflictException('user', '이미 출하 완료된 지시서입니다.', { code: COMPLETION_CONFLICT.ALREADY_COMPLETED });
}

/** 본문 영업일 — 날짜 형식만 본다(계약이 format: date). */
export function assertBusinessDate(body: ShipmentCompletionBody): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate ?? '')) throw one(field('businessDate', ERROR_CODE.INVALID, '영업일(YYYY-MM-DD)이 필요합니다.'));
}
