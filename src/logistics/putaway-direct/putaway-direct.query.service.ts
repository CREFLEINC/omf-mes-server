import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DesignatedGroupView, TemporaryWarehouseView, VERDICT_MESSAGES, VerdictCode, designationAddable, designationsOf, loadVerdictLocation, locationPaths,
  verdictOf,
} from './location-verdict';
import {
  PENDING_REASON_MESSAGES, PendingLotFacts, PendingLotView, PendingReason, pendingLotFacts, pendingLotView, pendingLotsOfPlant, pendingReasonOf,
} from './pending-lot-query';

export interface PendingLotQuery { plantId?: number; lotId?: number; page?: number; size?: number }

export interface PutAwayPlace { warehouseName: string; locationCode: string; locationPath: string; putawayModeCode?: string }

export interface PendingLotLookup {
  lotId?: number; lotNo: string; found: boolean; eligible: boolean; reasonCode?: PendingReason;
  putAway?: PutAwayPlace; putawayTaskIds?: number[]; lot?: PendingLotView;
  designated?: DesignatedGroupView[]; temporaryWarehouses?: TemporaryWarehouseView[];
}

export interface LocationCheckView {
  verdictCode: VerdictCode; locationId?: number; locationCode: string; locationPath?: string;
  warehouseId?: number; warehouseName?: string; isDefectWarehouse?: boolean; message: string;
  /** 미지정 위치 적치로 기록하면 이 위치의 보관 품목에 이 품목이 더해지는가(FR-017a) — PDA 확인 문구가 이 값을 본다. */
  designationAddable: boolean;
}

/** 지시 없는 적치의 읽기 셋(피처 009 contracts §1~§3) — 화면 M-01-05·M-01-07. 공장은 단말이면 단말 공장, 세션이면 질의 공장. */
@Injectable()
export class PutawayDirectQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(plantId: bigint, query: PendingLotQuery): Promise<PagedResponse<PendingLotView>> {
    const page = pageRequest({ page: query.page ?? 1, size: query.size ?? 100 });
    const rows = await pendingLotsOfPlant(this.prisma, plantId, query.lotId === undefined ? undefined : BigInt(query.lotId));
    return pagedResponse(rows.slice(page.skip, page.skip + page.take).map(pendingLotView), rows.length, page);
  }

  async lookup(plantId: bigint | null, lotNo: string): Promise<PendingLotLookup> {
    const found = (plantId === null ? null : await this.prisma.lot.findFirst({ where: { plant_id: plantId, lot_no: lotNo }, select: { lot_id: true } }))
      ?? await this.prisma.lot.findFirst({ where: { lot_no: lotNo }, select: { lot_id: true }, orderBy: { lot_id: 'asc' } });
    if (found === null) return { lotNo, found: false, eligible: false };
    const facts = (await pendingLotFacts(this.prisma, [found.lot_id])).get(found.lot_id) as PendingLotFacts;
    const reason = pendingReasonOf(facts, plantId);
    const head = { lotId: Number(facts.lotId), lotNo: facts.lotNo, found: true };
    if (reason === 'OTHER_PLANT' || reason === 'NOT_INBOUND') return { ...head, eligible: false, reasonCode: reason };
    if (reason !== null) {
      return {
        ...head, eligible: false, reasonCode: reason, lot: pendingLotView(facts),
        ...(reason === 'ALREADY_PUT_AWAY' ? { putAway: await this.putAwayPlace(facts.lotId) } : {}),
        ...(reason === 'HAS_TASK' ? { putawayTaskIds: facts.pendingTaskIds.map(Number) } : {}),
      };
    }
    const designations = await designationsOf(this.prisma, { plantId: facts.plantId, itemId: facts.itemId, defective: facts.statusCode === 'DEFECTIVE' });
    return { ...head, eligible: true, lot: pendingLotView(facts), ...designations };
  }

  async locationCheck(plantId: bigint | null, lotId: number, locationCode: string): Promise<LocationCheckView> {
    const facts = await this.pendingFacts(plantId, BigInt(lotId));
    const location = await loadVerdictLocation(this.prisma, { locationCode });
    const verdictCode = verdictOf(location, { plantId: facts.plantId, itemId: facts.itemId, defective: facts.statusCode === 'DEFECTIVE' });
    if (location === null) return { verdictCode, locationCode, message: VERDICT_MESSAGES[verdictCode], designationAddable: false };
    const path = (await locationPaths(this.prisma, [location.locationId])).get(location.locationId);
    return {
      verdictCode, locationId: Number(location.locationId), locationCode: location.locationCode, locationPath: path,
      warehouseId: Number(location.warehouseId), warehouseName: location.warehouseName, isDefectWarehouse: location.isDefect,
      message: VERDICT_MESSAGES[verdictCode], designationAddable: designationAddable(verdictCode, location),
    };
  }

  /** 적치 대기 LOT 의 판정 재료 — 아니면 404(없음)·409(이유 코드). 쓰기도 잠근 뒤 이것을 다시 부른다. */
  async pendingFacts(plantId: bigint | null, lotId: bigint, db: Parameters<typeof pendingLotFacts>[0] = this.prisma): Promise<PendingLotFacts> {
    const facts = (await pendingLotFacts(db, [lotId])).get(lotId);
    if (facts === undefined) throw new NotFoundException('없는 LOT 입니다.');
    const reason = pendingReasonOf(facts, plantId);
    if (reason === null) return facts;
    const place = reason === 'ALREADY_PUT_AWAY' ? await this.putAwayPlace(lotId) : undefined;
    const message = place === undefined ? PENDING_REASON_MESSAGES[reason] : `${PENDING_REASON_MESSAGES[reason]} (${place.locationPath})`;
    throw new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: reason, message }]);
  }

  /** 이미 적치된 자리 — 살아 있는 마지막 입고 라인의 도착 위치, 지시로 적치를 끝냈으면 그 실제 위치. */
  private async putAwayPlace(lotId: bigint): Promise<PutAwayPlace | undefined> {
    const line = await this.prisma.goods_receipt_line.findFirst({
      where: { lot_id: lotId, goods_receipt: { status_code: { in: ['POSTED', 'CANCEL_REQUESTED'] } } },
      orderBy: { goods_receipt_line_id: 'desc' },
      select: {
        destination_location_id: true, putaway_mode_code: true,
        putaway_task: { where: { actual_location_id: { not: null } }, select: { actual_location_id: true }, take: 1 },
      },
    });
    if (line === null) return undefined;
    const locationId = line.putaway_task[0]?.actual_location_id ?? line.destination_location_id;
    const location = await this.prisma.location.findUniqueOrThrow({
      where: { location_id: locationId }, select: { location_code: true, warehouse: { select: { warehouse_name: true } } },
    });
    return {
      warehouseName: location.warehouse.warehouse_name, locationCode: location.location_code,
      locationPath: (await locationPaths(this.prisma, [locationId])).get(locationId) ?? location.location_code,
      ...(line.putaway_mode_code === null ? {} : { putawayModeCode: line.putaway_mode_code }),
    };
  }
}
