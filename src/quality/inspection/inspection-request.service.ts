import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalQualityReadScope, terminalInspectionRequestWhere } from '../../auth/terminal-quality-read-scope';
import { InspectionGuideView, inspectionGuides } from './inspection-guide';
import { FOUR_M_CHANGE_INCLUDE, InspectionRequestView, inspectionRequestView } from './inspection-request-view';
import { InboundLotRequestDetailView, inboundLotRequestDetail, inboundLotSummaries } from './iqc-request-detail';

/** 조회 2건(I-19 PR ②). */
export interface InspectionRequestListQuery {
  inspectionTypeCode?: string;
  statusCode?: string;
  pendingOnly?: boolean;
  itemId?: number;
  supplierId?: number;
  lotId?: number;
  /** 입하 LOT(피처 005 §8) — 그 입하 LOT 의 IQC 요청(마감 취소로 무효가 된 옛 요청 포함). */
  inboundLotId?: number;
  /** LOT 의 공장(omf-all-around#211 · 장부 P-155) — 부품 공장 IQC 화면이 OA 공장 LOT 을 빼고 본다. */
  plantId?: number;
  workOrderId?: number;
  /**
   * 의뢰 시각 반열림 구간 `[from, to)`(omf-all-around#205) — 부품 IQC 화면의 「오늘 입고」. 공장 하루의 경계는 화면이 공장
   * 시간대로 셈해 시각(오프셋 포함)으로 보낸다 — 서버가 UTC 날짜로 자르면 베트남 공장의 아침 7시 전 입고가 전날로 빠진다.
   */
  requestedAtFrom?: string;
  requestedAtTo?: string;
  q?: string;
  page?: number;
  size?: number;
}

/** ⭐ 정의를 값으로 못박은 파생 축(계약) — `pendingOnly=true` ⇔ 이 2값. */
const PENDING_STATUS_CODES = ['REQUESTED', 'IN_PROGRESS'];
const IQC = 'IQC';

/** 계약에 `sort` 가 없다 — 검사 대기 큐라 「오래 기다린 것부터」로 서버가 고정한다(§4-1). */
const ORDER_BY: Prisma.inspection_requestOrderByWithRelationInput[] = [
  { requested_at: 'asc' },
  { inspection_request_id: 'asc' },
];

/** 상세 조회 — 목록 줄에 안내 문구(omf-all-around#252)와 입하 LOT 검사의 LOT·결과 목록(피처 005 §8)을 더한다. */
export type InspectionRequestDetailView = InspectionRequestView & { inspectionGuides?: InspectionGuideView[] } & Partial<InboundLotRequestDetailView>;

@Injectable()
export class InspectionRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InspectionRequestListQuery, scope?: TerminalQualityReadScope): Promise<PagedResponse<InspectionRequestView>> {
    const page = pageRequest(query);
    const where = await inspectionRequestListWhere(this.prisma, query, scope);
    const [rows, total] = await Promise.all([
      this.prisma.inspection_request.findMany({
        where, orderBy: ORDER_BY, skip: page.skip, take: page.take, include: FOUR_M_CHANGE_INCLUDE,
      }),
      this.prisma.inspection_request.count({ where }),
    ]);
    const [levels, inboundLots] = await Promise.all([iqcInspectionLevels(this.prisma, rows), inboundLotSummaries(this.prisma, rows)]);
    return pagedResponse(rows.map((row, index) => inspectionRequestView(row, levels[index], inboundLots[index])), total, page);
  }

  async detail(inspectionRequestId: number, scope?: TerminalQualityReadScope): Promise<InspectionRequestDetailView> {
    const byId: Prisma.inspection_requestWhereInput = { inspection_request_id: inspectionRequestId };
    const row = await this.prisma.inspection_request.findFirst({
      where: scope === undefined ? byId : { AND: [byId, await terminalInspectionRequestWhere(this.prisma, scope)] },
      include: FOUR_M_CHANGE_INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 검사 의뢰입니다.');
    const [[level], [inboundLot], inbound] = await Promise.all([
      iqcInspectionLevels(this.prisma, [row]), inboundLotSummaries(this.prisma, [row]), inboundLotRequestDetail(this.prisma, row),
    ]);
    // 안내 문구는 상세에만 싣는다 — 목록 줄마다 기준을 읽지 않는다(omf-all-around#252).
    const guides = await inspectionGuides(this.prisma, row);
    return { ...inspectionRequestView(row, level, inboundLot), ...(guides.length === 0 ? {} : { inspectionGuides: guides }), ...inbound };
  }
}

/**
 * IQC 의뢰의 검사 수준(#64 · 장부 P-87). 확정 때 기록한 값이 있으면 그것(그 LOT 을 검사한 수준)이고, 아직 대기·진행이면
 * 품목의 현재 수준이다. 수준 미설정 품목·IQC 밖 의뢰·기록 없이 끝난 의뢰는 비운다 — 지금 수준을 지난 검사에 붙이지 않는다.
 */
async function iqcInspectionLevels(
  prisma: PrismaService,
  rows: readonly { inspection_type_code: string; status_code: string; item_id: bigint; inspection_level_code: string | null }[],
): Promise<(string | undefined)[]> {
  const isCurrent = (row: (typeof rows)[number]) =>
    row.inspection_type_code === IQC && row.inspection_level_code === null && PENDING_STATUS_CODES.includes(row.status_code);
  const itemIds = [...new Set(rows.filter(isCurrent).map((row) => row.item_id))];
  const levels =
    itemIds.length === 0
      ? []
      : await prisma.item_inspection_level.findMany({
          where: { item_id: { in: itemIds } },
          select: { item_id: true, inspection_level_code: true },
        });
  const byItem = new Map(levels.map((level) => [level.item_id, level.inspection_level_code]));
  return rows.map((row) => {
    if (row.inspection_type_code !== IQC) return undefined;
    return row.inspection_level_code ?? (isCurrent(row) ? byItem.get(row.item_id) : undefined);
  });
}

function buildWhere(query: InspectionRequestListQuery): Prisma.inspection_requestWhereInput {
  return {
    ...(query.inspectionTypeCode === undefined ? {} : { inspection_type_code: query.inspectionTypeCode }),
    ...filter('item_id', query.itemId),
    ...filter('work_order_id', query.workOrderId),
    ...filter('inbound_lot_id', query.inboundLotId),
    // 상태(`AND`)·공급사·공장(둘 다 `lot`) 조건은 펼치면 서로 덮는다 — AND 하나로 묶는다.
    AND: [
      lotWhere(query.lotId),
      statusWhere(query),
      supplierWhere(query.supplierId),
      plantWhere(query.plantId),
      requestedAtWhere(query),
    ],
    // ⛔ 범위는 `inspection_request_no` «하나»다 — 공급사·품목은 훑지 않는다(계약).
    ...(query.q === undefined ? {} : { inspection_request_no: { contains: query.q, mode: Prisma.QueryMode.insensitive } }),
  };
}

/**
 * ⭐ #286 M-1 — `pendingOnly` 와 `statusCode` 를 **AND** 로 묶는다. 형제
 * `approval-request.service.ts:148,154` 와 같은 모양 — 예전엔 `pendingOnly=true` 가
 * `statusCode` 를 조용히 삼켰다(`pendingOnly=true&statusCode=IN_PROGRESS` 가 `statusCode` 를
 * 무시하고 REQUESTED·IN_PROGRESS 둘 다 돌려줬다).
 */
function statusWhere(query: InspectionRequestListQuery): Prisma.inspection_requestWhereInput {
  const conditions: Prisma.inspection_requestWhereInput[] = [];
  if (query.pendingOnly === true) conditions.push({ status_code: { in: PENDING_STATUS_CODES } });
  if (query.statusCode !== undefined) conditions.push({ status_code: query.statusCode });
  return conditions.length === 0 ? {} : { AND: conditions };
}

/**
 * ⚠ `lot.source_type_code`/`source_id` 다형 참조가 아니라 `inbound_receipt_line.lot_id`
 * 역방향 관계로 잇는다 — 계약이 「2단 조인」이라 적은 자리를 물리가 이 관계로 한 번에 준다
 * (§4-1 · `lot.inbound_receipt_line[]`).
 */
function supplierWhere(supplierId: number | undefined): Prisma.inspection_requestWhereInput {
  if (supplierId === undefined) return {};
  return {
    OR: [
      { lot: { inbound_receipt_line: { some: { inbound_receipt: { supplier_id: supplierId } } } } },
      // 입하 LOT 요청(`lot_id` 없음)은 입하 LOT 이 공급사를 갖는다(피처 005).
      { inbound_lot: { supplier_id: supplierId } },
    ],
  };
}

function plantWhere(plantId: number | undefined): Prisma.inspection_requestWhereInput {
  return plantId === undefined ? {} : { OR: [{ lot: { plant_id: plantId } }, { inbound_lot: { plant_id: plantId } }] };
}

/**
 * 「그 LOT 의 요청」 — 옛 요청은 `lot_id`, 입하 LOT 요청은 그 입하 LOT 의 자재 관리 LOT 에 든 것(피처 005).
 * ⛔ 두 번째 갈래는 `lot_id` 가 빈 요청만 — 이전된 옛 요청까지 입하 LOT 로 찾으면 옛 선별 자식 LOT 이 부모의 요청을 끌어온다.
 */
function lotWhere(lotId: number | undefined): Prisma.inspection_requestWhereInput {
  if (lotId === undefined) return {};
  return {
    OR: [
      { lot_id: BigInt(lotId) },
      { lot_id: null, inbound_lot: { lot: { some: { lot_id: BigInt(lotId) } } } },
    ],
  };
}

function requestedAtWhere(query: InspectionRequestListQuery): Prisma.inspection_requestWhereInput {
  const from = instantOf('requestedAtFrom', query.requestedAtFrom);
  const to = instantOf('requestedAtTo', query.requestedAtTo);
  if (from === undefined && to === undefined) return {};
  return { requested_at: { ...(from === undefined ? {} : { gte: from }), ...(to === undefined ? {} : { lt: to }) } };
}

/** 오프셋이 붙은 시각만 받는다 — 오프셋 없는 글자는 어느 시간대인지 몰라 400 이다. */
function instantOf(field: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(parsed.getTime())) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field, code: ERROR_CODE.INVALID, message: '시간대가 붙은 시각(예: 2026-10-30T00:00:00+07:00)이어야 합니다.' },
    ]);
  }
  return parsed;
}

/** 검사 의뢰 목록의 조건 + 단말 범위 — 단말 작업 수(POP OQC)가 같은 함수로 센다(omf-all-around#190). */
export async function inspectionRequestListWhere(
  prisma: PrismaService,
  query: InspectionRequestListQuery,
  scope?: TerminalQualityReadScope,
): Promise<Prisma.inspection_requestWhereInput> {
  return scope === undefined
    ? buildWhere(query)
    : { AND: [buildWhere(query), await terminalInspectionRequestWhere(prisma, scope)] };
}
