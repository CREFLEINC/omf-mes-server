import { PrismaService } from '../../prisma/prisma.service';
import {
  InspectionRequestLotJudgmentView,
  InspectionRequestResultView,
  RESULT_SELECT,
  ResultRow,
  lotJudgmentViews,
  reinspectionReasonNames,
  resultView,
} from './iqc-request-detail';
import { nextResultSequence } from './iqc-inbound-lot-result';
import { OqcLotStatus, isShipmentOqc, oqcLotStatusesOf } from './oqc-lot-result';

/**
 * 출하 OQC 새 흐름의 조회 칸(피처 010) — 의뢰 상세 `lots`·`results`·`lotJudgments`(IQC 와 같은 모양), 목록 행 요약.
 * 대상 LOT = 그 지시서·품목의 피킹 LOT. 교체된 LOT 은 매칭 대상이 아니고 이력으로만 싣는다(US3-5 · `pickStatusCode`).
 */

/** 계약 `InspectionRequestLot` + 출하 OQC 칸. 수량은 피킹 수량이다. */
export interface OqcRequestLotView {
  lotId: number;
  lotNo: string;
  lotQty: number;
  package: null;
  statusCode: string;
  goodsReceived: boolean;
  shipmentRequestLotId: number;
  pickStatusCode: string;
  managementCode: string | null;
}

/** 품목 표시 칸(P-04-06 목록 카드·머리 · 피처 010 검증 1회차) — POP 은 품목 마스터를 읽지 않는다. */
export interface OqcItemDisplay {
  itemCode: string;
  itemName: string;
  uomCode: string;
}

export interface OqcRequestDetailView extends OqcItemDisplay {
  shipmentRequestNo: string;
  lots: OqcRequestLotView[];
  results: InspectionRequestResultView[];
  lotJudgments: InspectionRequestLotJudgmentView[];
  nextResultSeqNo: number;
}

export interface OqcLotJudgmentSummary {
  notInspected: number;
  accepted: number;
  rejected: number;
  held: number;
}

export interface OqcRequestSummary extends OqcItemDisplay {
  shipmentRequestNo: string;
  pickedLotCount: number;
  /** 살아 있는 피킹 LOT 수량 합 — 카드 「피킹 LOT 3개 · 110 EA」. */
  pickedQty: number;
  lotJudgmentSummary: OqcLotJudgmentSummary;
}

type Row = { inspection_request_id: bigint; inspection_type_code: string; target_type_code: string; target_id: bigint; item_id: bigint; uom_id: bigint; lot_id: bigint | null };

/** 품목 코드·이름·단위 코드 — 의뢰 행들을 한 방씩 읽는다. */
async function itemDisplaysOf(prisma: PrismaService, rows: readonly Row[]): Promise<(row: Row) => OqcItemDisplay> {
  const unique = (values: bigint[]) => [...new Set(values.map(String))].map(BigInt);
  const [items, uoms] = await Promise.all([
    prisma.item.findMany({ where: { item_id: { in: unique(rows.map((row) => row.item_id)) } }, select: { item_id: true, item_code: true, item_name: true } }),
    prisma.uom.findMany({ where: { uom_id: { in: unique(rows.map((row) => row.uom_id)) } }, select: { uom_id: true, uom_code: true } }),
  ]);
  const itemOf = new Map(items.map((item) => [String(item.item_id), item]));
  const uomOf = new Map(uoms.map((uom) => [String(uom.uom_id), uom.uom_code]));
  return (row) => ({
    itemCode: itemOf.get(String(row.item_id))?.item_code ?? '',
    itemName: itemOf.get(String(row.item_id))?.item_name ?? '',
    uomCode: uomOf.get(String(row.uom_id)) ?? '',
  });
}

const lotsOf = (prisma: PrismaService, shipmentRequestIds: bigint[], itemIds: bigint[]) =>
  prisma.shipment_request_lot.findMany({
    where: { shipment_request_line: { shipment_request_id: { in: shipmentRequestIds }, item_id: { in: itemIds } } },
    orderBy: { shipment_request_lot_id: 'asc' },
    select: {
      shipment_request_lot_id: true, lot_id: true, picked_qty: true, status_code: true, management_code: true,
      lot: { select: { lot_no: true, status_code: true } },
      shipment_request_line: { select: { shipment_request_id: true, item_id: true } },
    },
  });

/** 상세 — 새 흐름 의뢰만. 그 밖은 `undefined`. */
export async function oqcRequestDetail(prisma: PrismaService, row: Row): Promise<OqcRequestDetailView | undefined> {
  if (!isShipmentOqc(row)) return undefined;
  const [request, lots, results, nextSeqNo, display] = await Promise.all([
    prisma.shipment_request.findUnique({ where: { shipment_request_id: row.target_id }, select: { shipment_request_no: true } }),
    lotsOf(prisma, [row.target_id], [row.item_id]),
    prisma.inspection_result.findMany({ where: { inspection_request_id: row.inspection_request_id }, orderBy: { inspection_round: 'asc' }, select: RESULT_SELECT }),
    nextResultSequence(prisma, row.inspection_request_id),
    itemDisplaysOf(prisma, [row]),
  ]);
  const live = lots.filter((lot) => lot.status_code !== 'REPLACED').map((lot) => ({ lot: { lot_id: lot.lot_id, lot_no: lot.lot.lot_no } }));
  // 배포 전 확정 결과(매칭 행 없음)는 피킹 LOT 전부를 매칭한 것으로 본다 — 판정 계산과 같은 규칙(`oqcLotStatuses`).
  const judged: ResultRow[] = results.map((result) =>
    result.inspection_result_lot.length === 0 && result.status_code === 'CONFIRMED' ? { ...result, inspection_result_lot: live } : result);
  const reasonNames = await reinspectionReasonNames(prisma, results);
  return {
    ...display(row),
    shipmentRequestNo: request?.shipment_request_no ?? '',
    lots: lots.map((lot) => ({
      lotId: Number(lot.lot_id), lotNo: lot.lot.lot_no, lotQty: Number(lot.picked_qty), package: null, statusCode: lot.lot.status_code,
      goodsReceived: false, shipmentRequestLotId: Number(lot.shipment_request_lot_id), pickStatusCode: lot.status_code,
      managementCode: lot.management_code,
    })),
    results: results.map((result) => resultView(result, reasonNames)),
    lotJudgments: lotJudgmentViews(lots.map((lot) => ({ lot_id: lot.lot_id, lot_no: lot.lot.lot_no })), judged, reasonNames),
    nextResultSeqNo: nextSeqNo,
  };
}

/** 목록 행 요약 — 지시서 번호·피킹 LOT 수·LOT 판정 수(POP 「판정 대기/판정 완료」 탭은 미검사 수로 가른다). */
export async function oqcListSummaries(prisma: PrismaService, rows: readonly Row[]): Promise<(OqcRequestSummary | undefined)[]> {
  const oqc = rows.filter(isShipmentOqc);
  if (oqc.length === 0) return rows.map(() => undefined);
  const requestIds = [...new Set(oqc.map((row) => row.target_id))];
  const [requests, lots, statuses, display] = await Promise.all([
    prisma.shipment_request.findMany({ where: { shipment_request_id: { in: requestIds } }, select: { shipment_request_id: true, shipment_request_no: true } }),
    lotsOf(prisma, requestIds, [...new Set(oqc.map((row) => row.item_id))]),
    oqcLotStatusesOf(prisma, requestIds),
    itemDisplaysOf(prisma, oqc),
  ]);
  const noOf = new Map(requests.map((request) => [String(request.shipment_request_id), request.shipment_request_no]));
  return rows.map((row) => {
    if (!isShipmentOqc(row)) return undefined;
    const members = lots.filter((lot) => lot.status_code !== 'REPLACED'
      && lot.shipment_request_line.shipment_request_id === row.target_id && lot.shipment_request_line.item_id === row.item_id);
    const count = (status: OqcLotStatus) => members.filter((lot) => statuses.get(lot.shipment_request_lot_id) === status).length;
    return {
      ...display(row),
      shipmentRequestNo: noOf.get(String(row.target_id)) ?? '',
      pickedLotCount: members.length,
      pickedQty: members.reduce((sum, lot) => sum + Number(lot.picked_qty), 0),
      lotJudgmentSummary: { notInspected: count('NOT_INSPECTED'), accepted: count('ACCEPTED'), rejected: count('REJECTED'), held: count('HELD') },
    };
  });
}
