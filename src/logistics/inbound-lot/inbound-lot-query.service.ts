import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { packageView, type MaterialPackageView } from '../material-lot-batch/material-lot-view';
import { lastRegistrations } from './inbound-lot-event';
import { LotFinalizeFacts, finalizableIds, finalizeFactsOf } from './inbound-lot-finalizable';
import { onlyOpenReceiptBlocks, reopenStatesOf } from './inbound-lot-reopenable';
import { InboundLotView, loadInboundLotViews } from './inbound-lot-view';

export interface InboundLotQuery {
  plantId: number;
  supplierId?: number;
  itemId?: number;
  statusCode?: string[] | string;
  closable?: boolean | string;
  reopenable?: boolean | string;
  closedAutomatically?: boolean | string;
  finalizable?: boolean | string;
  erpSendModeCode?: string;
  receivingDateFrom?: string;
  receivingDateTo?: string;
  q?: string;
  page?: number;
  size?: number;
}

/** 계약 `InboundLotMaterialLot`. */
export interface InboundLotMaterialLotView {
  lotId: number;
  lotNo: string;
  lotQty: number;
  package: MaterialPackageView | null;
  supplierLotNo: string | null;
  lifecycleStatusCode: string;
  statusCode: string;
  registeredAt: string;
  fromSupplierLabel: boolean;
  goodsReceived: boolean;
  dispositionStatusCode: 'IN_PROGRESS' | 'RETURNED' | 'DISPOSED' | null;
}

export interface InboundLotEventView {
  eventCode: string;
  occurredAt: string;
  actorName: string | null;
}

export interface InboundLotDetailView extends InboundLotView {
  lots: InboundLotMaterialLotView[];
  events: InboundLotEventView[];
}

const SUPPLIER_LOT = 'SUPPLIER_LOT';

/** 입하 LOT 조회(피처 005 §2) — PDA M-01-01·M-01-03 · 관리웹 W-01-16·W-01-01. */
@Injectable()
export class InboundLotQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InboundLotQuery): Promise<PagedResponse<InboundLotView>> {
    const page = pageRequest(query);
    const statuses = typeof query.statusCode === 'string' ? query.statusCode.split(',') : query.statusCode;
    const q = query.q?.trim();
    const where: Prisma.inbound_lotWhereInput = {
      plant_id: query.plantId,
      ...(query.supplierId === undefined ? {} : { supplier_id: query.supplierId }),
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      ...(statuses === undefined ? {} : { status_code: { in: statuses } }),
      ...(query.erpSendModeCode === undefined ? {} : { erp_send_mode_code: query.erpSendModeCode }),
      ...(query.receivingDateFrom === undefined && query.receivingDateTo === undefined ? {} : {
        receiving_date: {
          ...(query.receivingDateFrom === undefined ? {} : { gte: new Date(`${query.receivingDateFrom}T00:00:00Z`) }),
          ...(query.receivingDateTo === undefined ? {} : { lte: new Date(`${query.receivingDateTo}T00:00:00Z`) }),
        },
      }),
      ...(q ? { OR: [{ inbound_lot_no: { contains: q, mode: 'insensitive' } }, { item: { item_code: { contains: q, mode: 'insensitive' } } }] } : {}),
    };
    const closable = flag(query.closable);
    const reopenable = flag(query.reopenable);
    const closedAutomatically = flag(query.closedAutomatically);
    const finalizable = flag(query.finalizable);
    const and: Prisma.inbound_lotWhereInput[] = [];
    if (closable !== undefined) and.push(closable ? { status_code: 'RECEIVING' } : { status_code: { not: 'RECEIVING' } });
    if (closedAutomatically !== undefined) and.push({ closed_automatically: closedAutomatically });
    if (reopenable !== undefined) {
      const ids = await this.reopenableIds(query.plantId);
      and.push({ inbound_lot_id: reopenable ? { in: ids } : { notIn: ids } });
    }
    if (finalizable !== undefined) {
      const ids = await finalizableIds(this.prisma, { ...where, ...(and.length > 0 ? { AND: [...and] } : {}) });
      and.push({ inbound_lot_id: finalizable ? { in: ids } : { notIn: ids } });
    }
    if (and.length > 0) where.AND = and;
    const [total, items] = await Promise.all([
      this.prisma.inbound_lot.count({ where }),
      loadInboundLotViews(this.prisma, where, {
        orderBy: [{ receiving_date: 'desc' }, { inbound_lot_no: 'desc' }], skip: page.skip, take: page.size,
      }),
    ]);
    return pagedResponse(items, total, page);
  }

  /**
   * 마감 취소 목록(M-01-03) 입하 LOT — 판정이 집계(IQC 결과·입고·결재·같은 조합)라 SQL 조건으로 못 적어 후보(새 흐름 마감)를 모아 가른다.
   * 같은 조합 입하 중 하나만 막는 건도 넣는다 — 그쪽을 마감하면 풀리니 화면이 막힘 줄과 함께 보여 준다(행 reopenable 은 false).
   */
  private async reopenableIds(plantId: number): Promise<bigint[]> {
    const candidates = await this.prisma.inbound_lot.findMany({
      where: { plant_id: plantId, status_code: 'RECEIVED', erp_send_mode_code: 'ON_FINALIZE' }, select: { inbound_lot_id: true },
    });
    const states = await reopenStatesOf(this.prisma, candidates.map((row) => row.inbound_lot_id));
    return [...states].filter(([, state]) => state.blockers.length === 0 || onlyOpenReceiptBlocks(state.blockers)).map(([id]) => id);
  }

  async get(inboundLotId: number): Promise<InboundLotDetailView> {
    const id = BigInt(inboundLotId);
    const [view] = await loadInboundLotViews(this.prisma, { inbound_lot_id: id });
    if (view === undefined) throw new NotFoundException('없는 입하 LOT 입니다.');
    const [lots, registered, events, facts] = await Promise.all([
      this.prisma.lot.findMany({
        where: { inbound_lot_id: id },
        select: {
          lot_id: true, lot_no: true, initial_qty: true, lifecycle_status_code: true, status_code: true, created_at: true,
          package_uom_id: true, package_count: true, qty_per_package: true, package_uom: { select: { uom_code: true, uom_name: true } },
          lot_external_identifier: {
            where: { identifier_type_code: SUPPLIER_LOT }, select: { external_identifier: true },
            orderBy: { lot_external_identifier_id: 'asc' }, take: 1,
          },
        },
        orderBy: { lot_no: 'asc' },
      }),
      lastRegistrations(this.prisma, id),
      this.prisma.inbound_lot_event.findMany({
        where: { inbound_lot_id: id },
        select: { event_type_code: true, occurred_at: true, actor_user: { select: { user_name: true } }, actor_worker: { select: { worker_name: true } } },
        orderBy: [{ occurred_at: 'asc' }, { inbound_lot_event_id: 'asc' }],
      }),
      finalizeFactsOf(this.prisma, [id]),
    ]);
    const lotFacts = facts.get(id)?.lots ?? new Map<string, LotFinalizeFacts>();
    return {
      ...view,
      lots: lots.map((lot) => {
        const registration = registered.get(String(lot.lot_id));
        return {
          lotId: Number(lot.lot_id), lotNo: lot.lot_no, lotQty: Number(lot.initial_qty), package: packageView(lot),
          supplierLotNo: lot.lot_external_identifier[0]?.external_identifier ?? null,
          // 이전 데이터 LOT 은 생애가 NULL(= 사용 중)이다.
          lifecycleStatusCode: lot.lifecycle_status_code ?? 'ACTIVE', statusCode: lot.status_code,
          registeredAt: (registration?.at ?? lot.created_at).toISOString(),
          fromSupplierLabel: registration?.fromSupplierLabel ?? false,
          ...lotFinalizeView(lotFacts.get(String(lot.lot_id))),
        };
      }),
      events: events.map((event) => ({
        eventCode: event.event_type_code, occurredAt: event.occurred_at.toISOString(),
        actorName: event.actor_user?.user_name ?? event.actor_worker?.worker_name ?? null,
      })),
    };
  }
}

function lotFinalizeView(facts: LotFinalizeFacts | undefined): Pick<InboundLotMaterialLotView, 'goodsReceived' | 'dispositionStatusCode'> {
  if (facts === undefined) return { goodsReceived: false, dispositionStatusCode: null };
  const disposition = facts.inDisposition ? 'IN_PROGRESS' : facts.returned ? 'RETURNED' : facts.statusCode === 'SCRAPPED' ? 'DISPOSED' : null;
  // 취소 요청 중인 입고도 아직 살아 있다(반려되면 남는다).
  return { goodsReceived: facts.posted || facts.cancelPending, dispositionStatusCode: disposition };
}

function flag(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
}
