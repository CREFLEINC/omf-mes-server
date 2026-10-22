import { Injectable, NotFoundException } from '@nestjs/common';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import {
  CONSUMED_RELATION,
  INPUT_ROW_SELECT,
  InputWindow,
  WORK_ORDER_LOT_SOURCE,
  inputWindows,
  lotsAt,
  madeAt,
  tracedWorkOrders,
} from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { fourMChangeView } from '../../quality/inspection/four-m-change';

/** 투입 시각 기준 계보로 셌다(omf-all-around#166 · 장부 P-107) — 그래도 「추정」이다. */
export const GENEALOGY_BASIS = 'LOT_GENEALOGY_ESTIMATE';
/** 계보가 없는 W/O(#166 배포 전 실적) — 그 W/O 의 투입 전부·생산 LOT 전부로 센다(#108 방식). */
export const WORK_ORDER_BASIS = 'WORK_ORDER_ESTIMATE';
export type TraceBasis = typeof GENEALOGY_BASIS | typeof WORK_ORDER_BASIS;

export interface InputMaterialView {
  lotId: number;
  lotNo: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  fourMChange?: { changeTypeCode?: string; remarks?: string };
}

export interface InputMaterials {
  basis: TraceBasis;
  items: InputMaterialView[];
}

export interface UsedSerialView {
  serialNumberId: number;
  serialNo: string;
  lotId: number;
  lotNo: string;
  producedAt?: string;
}

export type UsedSerials = PagedResponse<UsedSerialView> & { basis: TraceBasis };


/**
 * 투입 자재 계보 조회(omf-all-around#166 · 장부 P-107) — 생산 LOT·시리얼의 투입 자재와 자재 LOT 이 들어간 시리얼.
 * 생산 LOT 은 실적이 남긴 `trace.lot_relation` 을 읽고, 시리얼은 같은 규칙(`lotsAt`)을 생산 시각에 대어 그 자리에서 센다.
 */
@Injectable()
export class LotGenealogyQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async ofProductionLot(lotId: number): Promise<InputMaterials> {
    const lot = await this.prisma.lot.findUnique({
      where: { lot_id: BigInt(lotId) },
      select: { source_type_code: true, source_id: true },
    });
    if (lot === null) throw new NotFoundException('없는 LOT 입니다.');
    if (lot.source_type_code !== WORK_ORDER_LOT_SOURCE) return { basis: GENEALOGY_BASIS, items: [] };
    if ((await tracedWorkOrders(this.prisma, [lot.source_id])).size === 0) {
      return { basis: WORK_ORDER_BASIS, items: await this.materials(await this.inputLotIds(lot.source_id)) };
    }
    const relations = await this.prisma.lot_relation.findMany({
      where: { target_lot_id: BigInt(lotId), relation_type_code: CONSUMED_RELATION },
      distinct: ['source_lot_id'],
      select: { source_lot_id: true },
    });
    return { basis: GENEALOGY_BASIS, items: await this.materials(relations.map((row) => row.source_lot_id)) };
  }

  async ofSerial(serialNo: string): Promise<InputMaterials> {
    const serial = await this.prisma.serial_number.findUnique({
      where: { serial_no: serialNo },
      select: { produced_at: true, created_at: true, lot: { select: { source_type_code: true, source_id: true } } },
    });
    if (serial === null) throw new NotFoundException('없는 시리얼입니다.');
    if (serial.lot.source_type_code !== WORK_ORDER_LOT_SOURCE) return { basis: GENEALOGY_BASIS, items: [] };
    const workOrderId = serial.lot.source_id;
    if ((await tracedWorkOrders(this.prisma, [workOrderId])).size === 0) {
      return { basis: WORK_ORDER_BASIS, items: await this.materials(await this.inputLotIds(workOrderId)) };
    }
    const windows = await this.windowsOf(workOrderId);
    return { basis: GENEALOGY_BASIS, items: await this.materials(lotsAt(windows, madeAt(serial)).map((w) => w.lotId)) };
  }

  /** 자재 LOT 이 들어간 시리얼 — 그 LOT 을 투입한 W/O 의 시리얼 중 생산 시각이 그 LOT 의 구간에 든 것. */
  async usedSerials(lotId: number, query: { page?: number; size?: number }): Promise<UsedSerials> {
    const page = pageRequest(query);
    const lot = await this.prisma.lot.findUnique({ where: { lot_id: BigInt(lotId) }, select: { lot_id: true } });
    if (lot === null) throw new NotFoundException('없는 LOT 입니다.');
    const consumed = await this.prisma.material_consumption.findMany({
      where: { lot_id: BigInt(lotId) },
      distinct: ['work_order_id'],
      select: { work_order_id: true },
    });
    const workOrderIds = consumed.map((row) => row.work_order_id);
    const traced = await tracedWorkOrders(this.prisma, workOrderIds);
    const found: UsedSerialView[] = [];
    for (const workOrderId of workOrderIds) {
      const mine = traced.has(workOrderId)
        ? (await this.windowsOf(workOrderId)).filter((w) => w.lotId === BigInt(lotId))
        : null;
      const serials = await this.prisma.serial_number.findMany({
        where: { lot: { source_type_code: WORK_ORDER_LOT_SOURCE, source_id: workOrderId } },
        select: {
          serial_number_id: true,
          serial_no: true,
          lot_id: true,
          produced_at: true,
          created_at: true,
          lot: { select: { lot_no: true } },
        },
      });
      for (const serial of serials) {
        if (mine !== null && lotsAt(mine, madeAt(serial)).length === 0) continue;
        found.push({
          serialNumberId: Number(serial.serial_number_id),
          serialNo: serial.serial_no,
          lotId: Number(serial.lot_id),
          lotNo: serial.lot.lot_no,
          ...(serial.produced_at === null ? {} : { producedAt: serial.produced_at.toISOString() }),
        });
      }
    }
    found.sort((a, b) => a.serialNumberId - b.serialNumberId);
    const basis = workOrderIds.every((id) => traced.has(id)) ? GENEALOGY_BASIS : WORK_ORDER_BASIS;
    return { basis, ...pagedResponse(found.slice(page.skip, page.skip + page.take), found.length, page) };
  }

  private async windowsOf(workOrderId: bigint): Promise<InputWindow[]> {
    return inputWindows(
      await this.prisma.material_consumption.findMany({ where: { work_order_id: workOrderId }, select: INPUT_ROW_SELECT }),
    );
  }

  private async inputLotIds(workOrderId: bigint): Promise<bigint[]> {
    const rows = await this.prisma.material_consumption.findMany({
      where: { work_order_id: workOrderId },
      distinct: ['lot_id'],
      select: { lot_id: true },
    });
    return rows.map((row) => row.lot_id);
  }

  private async materials(lotIds: readonly bigint[]): Promise<InputMaterialView[]> {
    if (lotIds.length === 0) return [];
    const rows = await this.prisma.lot.findMany({
      where: { lot_id: { in: [...new Set(lotIds)] } },
      select: {
        lot_id: true,
        lot_no: true,
        item_id: true,
        item: { select: { item_code: true, item_name: true } },
        lot_four_m_change: { select: { change_type_code: true, remarks: true } },
      },
      orderBy: [{ item: { item_code: 'asc' } }, { lot_no: 'asc' }],
    });
    return rows.map((row) => {
      const fourMChange = fourMChangeView(row.lot_four_m_change);
      return {
        lotId: Number(row.lot_id),
        lotNo: row.lot_no,
        itemId: Number(row.item_id),
        itemCode: row.item.item_code,
        itemName: row.item.item_name,
        ...(fourMChange === undefined ? {} : { fourMChange }),
      };
    });
  }
}
