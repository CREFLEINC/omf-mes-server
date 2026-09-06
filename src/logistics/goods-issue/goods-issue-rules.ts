import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 출고 «등록»의 트랜잭션 밖 검증. 입고 `goods-receipt.service.ts:129-217` 의 거울상이다.
 * ⛔ 없는 id 를 그냥 넘기면 FK 위반이 **500** 으로 샌다. 원장까지 열고 나서 터지므로 여기서
 * 먼저 본다 — 트랜잭션 밖의 읽기라 값이 그 사이 사라지면 FK 가 최종 방어다.
 */

/** 서버가 정한다 — 계약 본문에 `statusCode` 칸이 없다(§5-4). 전기는 `postImmediately` 가 옮긴다. */
export const REGISTERED = 'REGISTERED';

/** 계약 `GoodsIssueLineUpsert` — required 5. */
export interface GoodsIssueLineCreate {
  /** ⛔ 등록에서는 «무시한다» — `line_no` 는 「서버가 부여하며 화면이 정하지 않는다」(계약). */
  goodsIssueLineId?: number | null;
  pickingLineId?: number | null;
  itemId: number;
  lotId: number;
  issueQty: number;
  uomId: number;
  sourceLocationId: number;
}

/** 계약 `GoodsIssueCreate` — required 8. */
export interface GoodsIssueCreate {
  issueTypeCode: string;
  sourceDocumentTypeCode: string;
  sourceDocumentId: number;
  sourceWarehouseId: number;
  destinationTypeCode?: string | null;
  destinationId?: number | null;
  issuedAt: string;
  reasonCode?: string | null;
  replacementExpected?: boolean | null;
  /** ⛔ 받아서 «버린다» — 담을 칸이 없다(§8-1 ⓑ). `erpMessageQueued` 는 늘 false 다. */
  sendToErp?: boolean | null;
  postImmediately?: boolean | null;
  remarks?: string | null;
  /** ⛔ `postImmediately` 가 거짓이면 «저장하지 않는다» — 원장을 안 지난다(§2-5). */
  businessDate: string;
  occurredAt: string;
  lines: GoodsIssueLineCreate[];
}

/** 존재만 본다 — PK 로 세므로 인덱스 하나로 끝난다. 0 이면 없는 것이다. */
type Lookup = (prisma: PrismaService, id: number) => Promise<number>;

/**
 * 계약: 「**A-10 다형 참조 판별자**이고 값은 **대상 테이블 이름**이다」. 3값 그대로의 대응표다.
 * ⛔ `assertCodeValues` 를 쓰지 않는다 — 「공통코드 그룹으로 받지 않는다 … 고객이 늘릴 수 있는
 * 값이 아니다」(계약)이고 시드에 `SOURCE_DOCUMENT_TYPE` 그룹이 0건이다(§1-4 ①).
 * ⛔ FK 에 맡기지 않는다 — `source_document_id` 에 FK 가 «없어»(다형) 없는 문서를 가리키는
 * 전표가 그냥 선다.
 */
const SOURCE_DOCUMENT_TABLES: Record<string, Lookup> = {
  // 생산 투입 · 공급사 반품과 자재 폐기 · 제품 폐기 — 계약이 적은 세 표 그대로다.
  PICKING_ORDER: (prisma, id) => prisma.picking_order.count({ where: { picking_order_id: id } }),
  GOODS_RECEIPT: (prisma, id) => prisma.goods_receipt.count({ where: { goods_receipt_id: id } }),
  DISPOSITION_DECISION: (prisma, id) =>
    prisma.disposition_decision.count({ where: { disposition_decision_id: id } }),
};

const partner: Lookup = (prisma, id) => prisma.partner.count({ where: { partner_id: id } });

/** 도착지 4값 중 셋(널은 자체 폐기다). `PARTNER`·`DISPOSAL_SITE` 는 «같은 표»를 가리킨다 —
 *  값을 나눈 것은 화면이 거래처 목록을 역할로 좁히기 위해서다(계약 `x-internal-note` · §1-4 ②). */
const DESTINATION_TABLES: Record<string, Lookup> = {
  LOCATION: (prisma, id) => prisma.location.count({ where: { location_id: id } }),
  PARTNER: partner,
  DISPOSAL_SITE: partner,
};

/**
 * 전건 검증. 돌려주는 것은 **출발 창고의 공장**이다 — `goods_issue` 에 `plant_id` 가 없어
 * 채번과 원장의 공장 축을 창고에서 푼다(§8-3 ⓖ). 창고를 두 번 읽지 않으려고 여기서 낸다.
 */
export async function assertCreatable(
  prisma: PrismaService,
  input: GoodsIssueCreate,
): Promise<bigint> {
  const errors: ErrorItem[] = [];
  // 계약이 「최소 1행」이라 적었으나 `minItems` 를 걸지 않아 가드가 빈 배열을 통과시킨다.
  if (input.lines.length === 0) {
    errors.push(field('lines', ERROR_CODE.LINE_REQUIRED, '출고 라인이 1건 이상이어야 합니다.'));
  }
  // 「자체 폐기면 도착지 짝을 통째로 비운다」(계약) — 한쪽만 채우면 물리
  // `ck_goods_issue_destination` 위반이 `PrismaClientUnknownRequestError` 라 공용 그물에
  // 안 걸려 **500 으로 샌다**(`prisma-error.ts` 머리 주석) ⇒ 손검사로 앞당긴다(§1-4 ②).
  if ((input.destinationTypeCode != null) !== (input.destinationId != null)) {
    errors.push(field('destinationTypeCode', ERROR_CODE.PAIR, '도착지 유형과 대상은 짝입니다.'));
  }
  assertMoments(input, errors);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const plantId = await assertTargets(prisma, input);
  await assertCodeValues(prisma, [
    { field: 'issueTypeCode', value: input.issueTypeCode, groupCode: 'ISSUE_TYPE' },
    { field: 'reasonCode', value: input.reasonCode, groupCode: 'GOODS_ISSUE_REASON' },
  ]);
  return plantId;
}

/**
 * 세 시각의 «형식»만 본다. ⛔ 정규식만으로는 `2026-13-39` 가 통과한다 — 저장은 안 되지만
 * 채번의 기간 축으로 들어가 `GI-20261339-0001` 이 전표 번호에 영구히 남는다.
 */
function assertMoments(input: GoodsIssueCreate, errors: ErrorItem[]): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
    Number.isNaN(Date.parse(`${input.businessDate}T00:00:00Z`))
  ) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'));
  }
  for (const name of ['occurredAt', 'issuedAt'] as const) {
    if (Number.isNaN(Date.parse(input[name]))) {
      errors.push(field(name, ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
    }
  }
}

/** FK 그물 — 축마다 한 번씩 `IN` 으로 모아 읽는다(라인 수와 무관하게 왕복 8회다). */
async function assertTargets(prisma: PrismaService, input: GoodsIssueCreate): Promise<bigint> {
  const source = SOURCE_DOCUMENT_TABLES[input.sourceDocumentTypeCode];
  const target =
    input.destinationTypeCode == null ? undefined : DESTINATION_TABLES[input.destinationTypeCode];

  const [warehouse, sourceCount, targetCount, lineErrors] = await Promise.all([
    prisma.warehouse.findUnique({
      where: { warehouse_id: input.sourceWarehouseId },
      select: { plant_id: true },
    }),
    source === undefined ? 0 : source(prisma, input.sourceDocumentId),
    target === undefined || input.destinationId == null ? 0 : target(prisma, input.destinationId),
    lineTargetErrors(prisma, input.lines, input.sourceWarehouseId, 'lines'),
  ]);

  const errors: ErrorItem[] = [];
  if (!warehouse) errors.push(field('sourceWarehouseId', ERROR_CODE.INVALID, '없는 창고입니다.'));
  if (sourceCount === 0) {
    errors.push(field('sourceDocumentId', ERROR_CODE.INVALID, '없는 원천 문서입니다.'));
  }
  if (input.destinationId != null && targetCount === 0) {
    errors.push(field('destinationId', ERROR_CODE.INVALID, '없는 도착지입니다.'));
  }
  errors.push(...lineErrors);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return (warehouse as { plant_id: bigint }).plant_id;
}

/**
 * 라인 축 FK 그물 — 등록과 «치환»(PR ⑤)이 나눠 쓴다. ⛔ 던지지 않고 «모아 돌려준다» —
 * 등록은 헤더 축 오류와 한 응답에 합쳐야 하고 치환은 헤더 축이 없다.
 * `sourceWarehouseId` 는 등록이면 본문 값, 치환이면 «잠근 헤더»의 `source_warehouse_id` 다.
 * `at` 은 오류가 짚을 배열 이름이다(등록 `lines` · 치환 `items` — 계약 본문 칸 이름이 다르다).
 */
export async function lineTargetErrors(
  prisma: PrismaService,
  lines: GoodsIssueLineCreate[],
  sourceWarehouseId: number,
  array: 'lines' | 'items',
): Promise<ErrorItem[]> {
  const ids = (of: (line: GoodsIssueLineCreate) => number | null | undefined): number[] => [
    ...new Set(lines.map(of).filter((id): id is number => id != null)),
  ];
  const [items, lots, uoms, locations, pickingLines] = await Promise.all([
    prisma.item.findMany({ where: { item_id: { in: ids((l) => l.itemId) } }, select: { item_id: true } }),
    prisma.lot.findMany({
      where: { lot_id: { in: ids((l) => l.lotId) } },
      select: { lot_id: true, item_id: true },
    }),
    prisma.uom.findMany({ where: { uom_id: { in: ids((l) => l.uomId) } }, select: { uom_id: true } }),
    prisma.location.findMany({
      where: { location_id: { in: ids((l) => l.sourceLocationId) } },
      select: { location_id: true, warehouse_id: true },
    }),
    prisma.picking_line.findMany({
      where: { picking_line_id: { in: ids((l) => l.pickingLineId) } },
      select: { picking_line_id: true },
    }),
  ]);

  const errors: ErrorItem[] = [];
  const itemIds = new Set(items.map((row) => Number(row.item_id)));
  const lotItems = new Map(lots.map((row) => [Number(row.lot_id), Number(row.item_id)]));
  const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));
  const homes = new Map(locations.map((row) => [Number(row.location_id), Number(row.warehouse_id)]));
  const pickingLineIds = new Set(pickingLines.map((row) => Number(row.picking_line_id)));

  for (const [index, line] of lines.entries()) {
    const at = `${array}[${index}]`;
    if (!itemIds.has(line.itemId)) errors.push(field(`${at}.itemId`, ERROR_CODE.INVALID, '없는 품목입니다.'));
    if (!uomIds.has(line.uomId)) errors.push(field(`${at}.uomId`, ERROR_CODE.INVALID, '없는 단위입니다.'));
    if (!lotItems.has(line.lotId)) {
      errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '없는 LOT 입니다.'));
    } else if (lotItems.get(line.lotId) !== line.itemId) {
      // LOT 과 품목이 어긋나면 원장이 거짓을 적는다 — 계보가 그 두 축으로 이어진다.
      errors.push(field(`${at}.itemId`, ERROR_CODE.INVALID, '이 LOT 의 품목이 아닙니다.'));
    }
    if (!homes.has(line.sourceLocationId)) {
      errors.push(field(`${at}.sourceLocationId`, ERROR_CODE.INVALID, '없는 위치입니다.'));
    } else if (homes.get(line.sourceLocationId) !== sourceWarehouseId) {
      // 남의 창고 위치에서 내면 잔액 차원이 창고와 위치가 서로 다른 곳을 가리키는 행이 된다.
      errors.push(field(`${at}.sourceLocationId`, ERROR_CODE.INVALID, '이 창고의 위치가 아닙니다.'));
    }
    // I-4 는 받아서 «저장만» 한다 — 피킹 수량 대조(`ck_picking_qty`)는 I-8 몫이다(§7-2).
    if (line.pickingLineId != null && !pickingLineIds.has(line.pickingLineId)) {
      errors.push(field(`${at}.pickingLineId`, ERROR_CODE.INVALID, '없는 피킹 라인입니다.'));
    }
  }
  return errors;
}
