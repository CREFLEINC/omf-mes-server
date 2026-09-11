import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import {
  GoodsIssueLineWriteInput,
  postIssue,
} from '../goods-issue/issue-posting';
import { postReceipt } from '../goods-receipt/receipt-posting';
import { assertLotsReleased } from './shipment-rules';

/**
 * 출하 등록 한 트랜잭션 — 출하 · 라인 · LOT 배분 · **출고 전표** · 원장 출고 전기 · 되짚기.
 * 「출하·라인·LOT 배분을 한 트랜잭션으로 만든다」(계약 · 공유계약 B-8).
 *
 * ⭐⭐ **순서가 불변식이다** — ① LOT 을 읽고 품질 게이트 ② **출하 헤더** ③ 잔액 잠금·위치 해소
 * ④ 출고 전표 ⑤ 원장(`postIssue`) ⑥ 출하 라인·배분·되짚기.
 * ⛔ **②가 ④보다 앞이어야 한다** — 출고 전표의 원천 id 가 **이 출하**다(A-10: 판별자 `SHIPMENT`
 * 의 짝 id 는 `logistics.shipment` 의 식별자다). 처음엔 헤더를 맨 뒤에 두고 원천 id 에
 * **출하작업지시 id** 를 넣었다 — 「없는 표를 가리키는 유령 참조」였고 단위·e2e 가 그 틀린 값을
 * 오히려 못 박고 있었다(PR ⑤ 작성 중 발견).
 *
 * ⭐⭐ **판별자 — 출고 전표를 «만든다»**(자리 ① · 계획서 §3-2 ⓐ). 원장의
 * `sourceDocumentTypeCode` 는 `GOODS_ISSUE` 라 **원장 enum 5값 안에 그대로 들어간다.**
 * ⛔ 전표를 안 만들고 원장에 `SHIPMENT` 를 직접 실으면 `InventoryTransaction.
 * sourceDocumentTypeCode`(required + enum)를 벗어나 **I-17 이 세운 가드가 나중에 부서진다.**
 * ⚠ `goods_issue.source_document_type_code = 'SHIPMENT'` 는 계약 `GoodsIssue` 의 enum
 * **3값 밖**이다 — 그 한 자리를 통보 217 ⓐ 로 올린다(거울 쪽 `GoodsReceipt` 에는 이미 있다).
 *
 * ⭐⭐ **`postIssue()` 를 «부른다»** — I-4 가 적어 둔 금지를 실측으로 뒤집었다(§3-2 ⓓ 정정).
 * 근거는 `issue-posting.ts` 머리 주석에 옮겨 적었다. 안 부르면 잔액 선잠금·키별 합계·피킹
 * 소진·손검사·되짚기 ~150줄을 복제하고 **조용히 갈릴 자리가 셋** 생긴다.
 */

const ISSUE_TYPE = 'SHIPMENT';
/** ⭐ 원장 판별자가 아니라 **전표의 원천 유형**이다 — 원장은 `postIssue` 가 `GOODS_ISSUE` 로 쓴다. */
const SOURCE_DOCUMENT_TYPE = 'SHIPMENT';
const POSTED = 'POSTED';
const UNCONFIRMED = 'UNCONFIRMED';
/**
 * 긴급 직행이 만드는 «제품 입고»의 두 칸 — 계약이 **서버에 위임**했다(「입고 유형·원천 문서
 * 유형은 서버가 정한다」 · 결정 통보 221).
 * ⭐ `PRODUCT` 는 계약이 「제품입고(PRODUCT)로 확정」이라 못 박은 값이고, `SHIPMENT` 는
 * `GoodsReceipt.sourceDocumentTypeCode` enum 4값에 실재한다(→ `logistics.shipment`).
 * ⛔ 「그 값은 반품 클레임 입고 전용이다」는 오독이다 — A-10 규약상 값의 뜻은 «가리킬 표의
 * 이름»이고 괄호 속 `W-04-06` 은 당시 알려진 사용처다.
 */
const RECEIPT_TYPE = 'PRODUCT';
const RECEIPT_SOURCE = 'SHIPMENT';
/** 품질 게이트가 「Release 만」을 통과시켰으므로 입고 잔액의 품질 축도 정상이다. */
const QUALITY_NORMAL = 'NORMAL';
const INVENTORY_AVAILABLE = 'AVAILABLE';
/**
 * ⭐⭐ **긴급 직행의 «피킹 소진 축»** — `postIssue` 헤더의 `sourceDocumentTypeCode` 는 **저장되지
 * 않고** 소진 게이트에만 쓰인다(`issue-posting.ts` 의 `CONSUMES_PICKED` · 실측 사용처 하나).
 * 출고 전표 행은 이 파일이 `SHIPMENT` 로 직접 만든다.
 * 긴급 직행은 **피킹을 건너뛰어** 방금 입고한 재고에서 나가므로 `picked_qty` 가 0 이다 —
 * 평시처럼 `SHIPMENT` 를 넘기면 소진이 0행이 되어 **긴급 본길이 언제나 400** 이다.
 * ⇒ 재고의 실제 출처(«입고»)를 넘긴다 — `CONSUMES_PICKED` 밖이라 소진이 돌지 않는다.
 */
const EXPEDITED_CONSUME_AXIS = 'GOODS_RECEIPT';

export interface ShipmentAllocationWrite {
  lotId: number;
  allocatedQty: number;
  uomId: number;
  handlingUnitId?: number | null;
}

export interface ShipmentLineWrite {
  shipmentRequestLineId: number;
  shippedQty: number;
  uomId: number;
  allocations: ShipmentAllocationWrite[];
}

export interface ShipmentCreateWrite {
  shipmentRequestId: number;
  warehouseId: number;
  vehicleNo?: string;
  driverName?: string;
  sealNo?: string;
  transportDocumentNo?: string;
  loadingWorkerId?: number;
  carrierId?: number;
  expedited?: boolean;
  expediteReason?: string | null;
  remarks?: string;
  businessDate: string;
  occurredAt: string;
  lines: ShipmentLineWrite[];
}

export interface ShipmentWrite {
  input: ShipmentCreateWrite;
  shipmentNo: string;
  goodsIssueNo: string;
  /** ⭐ 긴급 직행일 «때만» 온다 — 평시엔 입고 전표가 0건이라 번호를 안 뽑는다. */
  goodsReceiptNo?: string;
  /** 긴급 직행의 장부상 입고 위치 — 본문에 칸이 0개라 서비스가 창고 관리수준으로 푼다(§3-6 ⓒ). */
  receiptLocationId?: bigint;
  /** 라인마다의 품목 — 본문에 `itemId` 가 없어 `shipment_request_line` 에서 서버가 푼다(§6). */
  itemIdByLine: bigint[];
  appUserId: number;
}

type Tx = Prisma.TransactionClient;

/** 배분 하나가 깎을 잔액 행 — 위치는 본문에 없어 잠근 잔액에서 «푼다». */
interface Source {
  lotId: bigint;
  itemId: bigint;
  locationId: bigint;
  statusCode: string;
}

export async function postShipment(
  tx: Tx,
  posting: InventoryPostingService,
  write: ShipmentWrite,
): Promise<bigint> {
  const { input } = write;
  const lots = await readLots(tx, input);

  // ⭐ 품질 게이트가 «맨 앞»이다 — 어떤 행도 쓰기 전에 막는다. 계약 「Release 가 아니면 400」.
  //   ⛔ 초판은 「잔액을 잠근 뒤라 안전하다」고 적었는데 **근거가 틀렸다** — 잔액 잠금은
  //   `trace.lot` 행을 잠그지 않는다. LOT 상태를 지키는 잠금은 애초에 그 자리에 없었다.
  assertLotsReleased(
    [...lots.values()].map((lot) => ({ lotId: lot.lot_id, statusCode: lot.status_code })),
    (lotId) => pathOfLot(input, lotId),
  );

  const shipmentId = await createShipmentHeader(tx, write);
  // ⭐⭐ **긴급 직행은 입고 전기가 출고 전기보다 «먼저»다**(§3-6 ⓐ). 대상이 「아직 입고 안 된
  //    LOT」이라 잔액 행이 없다 — 뒤집으면 아래 `resolveSources` 가 0행으로 400 을 낸다.
  //    ⚠ 헤더 «뒤»다 — 입고 전표의 원천 id 도 이 출하다(A-10).
  const expedited = input.expedited === true;
  if (expedited) await postExpeditedReceipt(tx, posting, write, shipmentId, lots);
  const sources = await resolveSources(tx, write, lots);

  const issue = await tx.goods_issue.create({
    data: {
      goods_issue_no: write.goodsIssueNo,
      issue_type_code: ISSUE_TYPE,
      source_document_type_code: SOURCE_DOCUMENT_TYPE,
      // ⭐ 짝 id 는 «이 출하»다 — 판별자 SHIPMENT 가 가리키는 표가 logistics.shipment 다(A-10).
      source_document_id: shipmentId,
      source_warehouse_id: BigInt(input.warehouseId),
      // ⛔ 고객에게 나간다 — 도착 두 칸은 «둘 다» NULL 이다(`ck_goods_issue_destination` 짝 규칙).
      issued_at: new Date(input.occurredAt),
      status_code: POSTED,
      created_by: BigInt(write.appUserId),
    },
  });

  const issueLines: GoodsIssueLineWriteInput[] = [];
  const flat = flatten(input);
  for (const [index, entry] of flat.entries()) {
    const source = sources[index];
    const created = await tx.goods_issue_line.create({
      data: {
        goods_issue_id: issue.goods_issue_id,
        line_no: index + 1,
        item_id: source.itemId,
        lot_id: source.lotId,
        issue_qty: entry.allocation.allocatedQty,
        uom_id: BigInt(entry.allocation.uomId),
        source_location_id: source.locationId,
      },
    });
    issueLines.push({
      goodsIssueLineId: created.goods_issue_line_id,
      itemId: source.itemId,
      lotId: source.lotId,
      issueQty: new Prisma.Decimal(entry.allocation.allocatedQty),
      uomId: BigInt(entry.allocation.uomId),
      sourceLocationId: source.locationId,
    });
  }

  // ⭐ 원장·소진·손검사·되짚기가 여기 한 줄에 다 있다. ⛔ 이 안을 복제하지 않는다.
  await postIssue(
    tx,
    posting,
    {
      header: {
        goodsIssueId: issue.goods_issue_id,
        goodsIssueNo: write.goodsIssueNo,
        issueTypeCode: ISSUE_TYPE,
        // ⭐ 이 값이 «피킹 소진의 축»이다 — `CONSUMES_PICKED` 에 있어야 `picked_qty` 가 내려간다.
        //   긴급 직행은 피킹이 0 이라 축 밖의 값을 넘긴다(`EXPEDITED_CONSUME_AXIS`).
        sourceDocumentTypeCode: expedited ? EXPEDITED_CONSUME_AXIS : SOURCE_DOCUMENT_TYPE,
        sourceDocumentId: shipmentId,
        sourceWarehouseId: BigInt(input.warehouseId),
        destinationTypeCode: null,
        destinationId: null,
      },
      lines: issueLines,
      // ⛔ 본문 값 그대로다 — 서버가 수신 시각으로 다시 잡지 않는다(C-8 · CLAUDE.md).
      businessDate: input.businessDate,
      occurredAt: new Date(input.occurredAt),
    },
    write.appUserId,
  );

  await writeShipmentLines(tx, write, shipmentId, issueLines);
  return shipmentId;
}

/**
 * ⭐⭐ **긴급 직행의 «제품 입고»** — 계약 「참이면 서버가 제품 입고 전표와 입고 전기를 같은
 * 트랜잭션에서 함께 만든다 — 화면이 01 계약을 따로 부르지 않는다」(`W-04-05`).
 *
 * ⭐ `postReceipt()` 를 «부른다» — 전표·전기·되짚기를 복제하지 않는다(같은 logistics 도메인의
 * export 함수 · §3-6 ⓓ).
 * ⛔ **적치 지시를 만들지 않는다**(`putawayNos: null`) — 창고 경유를 건너뛰는 경로라 물건이 곧바로
 * 나간다. 만들면 현장이 `W-01-12` 에서 유령 작업을 본다.
 * ⭐ 입고 위치와 출고 위치가 **같다** — 출고는 방금 선 잔액 행에서 위치를 푼다(`resolveSources`).
 */
async function postExpeditedReceipt(
  tx: Tx,
  posting: InventoryPostingService,
  write: ShipmentWrite,
  shipmentId: bigint,
  lots: Map<string, LotRow>,
): Promise<void> {
  const { input, goodsReceiptNo, receiptLocationId } = write;
  if (goodsReceiptNo === undefined || receiptLocationId === undefined) {
    throw new Error('긴급 직행인데 입고 번호·위치가 없다 — 서비스가 풀지 않았다.');
  }
  const flat = flatten(input);
  // 없는 LOT 이 섞였으면 입고를 세우지 않는다 — `resolveSources` 가 400 으로 짚고 전체가 되돌려진다.
  if (flat.some((entry) => !lots.has(String(entry.allocation.lotId)))) return;
  const warehouse = await tx.warehouse.findUniqueOrThrow({
    where: { warehouse_id: BigInt(input.warehouseId) },
    select: { plant_id: true },
  });
  await postReceipt(
    tx,
    posting,
    {
      receiptTypeCode: RECEIPT_TYPE,
      plantId: Number(warehouse.plant_id),
      warehouseId: input.warehouseId,
      receiptDatetime: input.occurredAt,
      sourceDocumentTypeCode: RECEIPT_SOURCE,
      sourceDocumentId: Number(shipmentId),
      // ⛔ 본문 값 그대로다 — 서버가 수신 시각으로 다시 잡지 않는다(C-8).
      businessDate: input.businessDate,
      lines: flat.map((entry) => ({
        itemId: Number((lots.get(String(entry.allocation.lotId)) as LotRow).item_id),
        lotId: entry.allocation.lotId,
        receiptQty: entry.allocation.allocatedQty,
        uomId: entry.allocation.uomId,
        qualityStatusCode: QUALITY_NORMAL,
        inventoryStatusCode: INVENTORY_AVAILABLE,
        destinationLocationId: Number(receiptLocationId),
      })),
    },
    write.appUserId,
    goodsReceiptNo,
    // ⛔ `null` — 적치 지시 0건. 빈 배열이면 `putawayNos[index]` 가 undefined 라 NOT NULL 위반 500 이다.
    null,
  );
}

/** 출하 헤더 — 출고 전표보다 «먼저» 선다(원천 id 가 이것이다). */
async function createShipmentHeader(tx: Tx, write: ShipmentWrite): Promise<bigint> {
  const { input } = write;
  const shipment = await tx.shipment.create({
    data: {
      shipment_no: write.shipmentNo,
      shipment_request_id: BigInt(input.shipmentRequestId),
      warehouse_id: BigInt(input.warehouseId),
      // ⛔ 확정하지 않는다 — 계약이 「미확정 출하까지이고 확정은 `:confirm` 이다」로 못 박았다.
      status_code: UNCONFIRMED,
      shipped_at: new Date(input.occurredAt),
      expedited: input.expedited ?? false,
      expedite_reason: input.expediteReason ?? null,
      vehicle_no: input.vehicleNo ?? null,
      driver_name: input.driverName ?? null,
      seal_no: input.sealNo ?? null,
      transport_document_no: input.transportDocumentNo ?? null,
      loading_worker_id: input.loadingWorkerId === undefined ? null : BigInt(input.loadingWorkerId),
      carrier_id: input.carrierId === undefined ? null : BigInt(input.carrierId),
      remarks: input.remarks ?? null,
      created_by: BigInt(write.appUserId),
    },
  });
  return shipment.shipment_id;
}

/** 출하 라인 · 배분 + 되짚기 한 칸. 전기 «뒤»다 — 되짚을 출고 라인 id 가 필요하다. */
async function writeShipmentLines(
  tx: Tx,
  write: ShipmentWrite,
  shipmentId: bigint,
  issueLines: GoodsIssueLineWriteInput[],
): Promise<void> {
  const { input } = write;
  let cursor = 0;
  for (const [index, line] of input.lines.entries()) {
    const created = await tx.shipment_line.create({
      data: {
        shipment_id: shipmentId,
        line_no: index + 1,
        shipment_request_line_id: BigInt(line.shipmentRequestLineId),
        item_id: write.itemIdByLine[index],
        shipped_qty: line.shippedQty,
        uom_id: BigInt(line.uomId),
        // ⭐ 되짚기 — 계약이 「잔재」라 불렀지만 칸과 FK 가 실재하고 이 판정에서는 «값이 있다».
        //   ⚠ 라인 하나에 배분이 여럿이면 출고 라인도 여럿이다 — 그 «첫» 줄을 가리킨다.
        goods_issue_line_id: issueLines[cursor].goodsIssueLineId,
      },
    });
    for (const allocation of line.allocations) {
      await tx.shipment_lot_allocation.create({
        data: {
          shipment_line_id: created.shipment_line_id,
          lot_id: BigInt(allocation.lotId),
          allocated_qty: allocation.allocatedQty,
          uom_id: BigInt(allocation.uomId),
          handling_unit_id:
            allocation.handlingUnitId == null ? null : BigInt(allocation.handlingUnitId),
        },
      });
      cursor += 1;
    }
  }
}

interface FlatAllocation {
  lineIndex: number;
  allocationIndex: number;
  allocation: ShipmentAllocationWrite;
}

/** 배분을 라인 순서대로 편다 — 출고 라인이 배분 하나에 하나씩 선다. */
function flatten(input: ShipmentCreateWrite): FlatAllocation[] {
  return input.lines.flatMap((line, lineIndex) =>
    line.allocations.map((allocation, allocationIndex) => ({
      lineIndex,
      allocationIndex,
      allocation,
    })),
  );
}

/**
 * ⭐⭐ **본문에 위치가 «0개»다** — 배분은 `lotId` 만 준다. 그 LOT 의 잔액 행에서 푼다.
 *
 * ⛔ `lockBalancesByItemLot()` 로 **먼저 잠근다**(`inventory_balance_id` 순서). 안 잠그고 읽으면
 * 그 사이 다른 트랜잭션이 위치를 바꿔 `postIssue` 가 «다른 행»을 잠근다. 코어와 **같은 순서**로
 * 잠그므로 교착 창이 열리지 않는다.
 * ⛔ 그 창고에 그 LOT 의 행이 **정확히 하나**여야 한다 — 0행이면 재고가 없고, 2행+ 면 계약이
 * 품질·재고 상태 칸을 안 실어 **어느 것을 낼지 정할 수 없다**(출고 코어가 같은 자리에서 같은
 * 판정을 한다 · `issue-posting.ts:131-141`).
 */
type LotRow = { lot_id: bigint; item_id: bigint; status_code: string };

/** 배분이 가리키는 LOT 을 «한 번» 읽는다 — 품질 게이트와 위치 해소가 같은 행을 쓴다. */
async function readLots(tx: Tx, input: ShipmentCreateWrite): Promise<Map<string, LotRow>> {
  const lotIds = [...new Set(flatten(input).map((entry) => BigInt(entry.allocation.lotId)))];
  const lots = await tx.lot.findMany({
    where: { lot_id: { in: lotIds } },
    select: { lot_id: true, item_id: true, status_code: true },
  });
  return new Map(lots.map((lot) => [lot.lot_id.toString(), lot]));
}

async function resolveSources(
  tx: Tx,
  write: ShipmentWrite,
  lotById: Map<string, LotRow>,
): Promise<Source[]> {
  const { input } = write;
  const errors: ErrorItem[] = [];
  const sources: Source[] = [];

  for (const entry of flatten(input)) {
    const path = `lines[${entry.lineIndex}].allocations[${entry.allocationIndex}].lotId`;
    const lot = lotById.get(String(entry.allocation.lotId));
    if (lot === undefined) {
      errors.push(field(path, ERROR_CODE.INVALID, '없는 LOT 입니다.'));
      continue;
    }
    const rows = (await lockBalancesByItemLot(tx, lot.item_id, lot.lot_id)).filter(
      (row) => row.warehouseId === BigInt(input.warehouseId),
    );
    if (rows.length === 0) {
      errors.push(field(path, ERROR_CODE.NEGATIVE_BALANCE, '이 창고에 그 LOT 의 재고가 없습니다.'));
      continue;
    }
    if (rows.length > 1) {
      errors.push(
        field(path, ERROR_CODE.INVALID, '재고 차원이 둘 이상이라 어느 것을 낼지 정할 수 없습니다.'),
      );
      continue;
    }
    sources.push({
      lotId: lot.lot_id,
      itemId: lot.item_id,
      locationId: rows[0].locationId,
      statusCode: lot.status_code,
    });
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return sources;
}

/** 품질 게이트가 짚을 자리 — LOT 을 «처음» 쓴 배분이다. */
function pathOfLot(input: ShipmentCreateWrite, lotId: bigint | number): string {
  const entry = flatten(input).find((item) => BigInt(item.allocation.lotId) === BigInt(lotId));
  return entry === undefined
    ? 'lines'
    : `lines[${entry.lineIndex}].allocations[${entry.allocationIndex}].lotId`;
}
