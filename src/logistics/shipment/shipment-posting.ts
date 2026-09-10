import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { postReceipt } from '../goods-receipt/receipt-posting';
import {
  GoodsIssueLineWriteInput,
  postIssue,
} from '../goods-issue/issue-posting';
import { assertLotsReleased, assertQty } from './shipment-rules';

/**
 * 출하 등록 한 트랜잭션 — 출하 · 라인 · LOT 배분 · **출고 전표** · 원장 출고 전기 · 되짚기.
 * 「출하·라인·LOT 배분을 한 트랜잭션으로 만든다」(계약 · 공유계약 B-8).
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
 * 긴급 직행이 만드는 «제품 입고» 두 칸 — 계약이 **서버에 위임**했다(「입고 유형·원천 문서
 * 유형은 서버가 정한다」 · 결정 통보 221).
 * ⭐ `PRODUCT` 는 계약이 「제품입고(PRODUCT)로 **확정**」이라 못 박은 값이고, `SHIPMENT` 는
 * `GoodsReceipt.sourceDocumentTypeCode` enum **4값에 실재**한다(→ `logistics.shipment`).
 * ⛔ 「그 값은 반품 클레임 입고 전용이다」는 **오독**이다 — A-10 규약상 값의 뜻은 「가리킬
 * «표»의 이름」이고 괄호 속 `W-04-06` 은 당시 알려진 **사용처**다.
 */
const RECEIPT_TYPE = 'PRODUCT';
const RECEIPT_SOURCE = 'SHIPMENT';
const QUALITY_NORMAL = 'NORMAL';
const INVENTORY_AVAILABLE = 'AVAILABLE';

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
  /** 긴급 직행의 장부상 입고 위치 — 본문에 칸이 0개라 서버가 푼다(§3-6 ⓒ). */
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
  // ⭐⭐ **긴급 직행은 입고 전기가 «먼저»다**(§3-6 ⓐ). 대상이 「아직 입고 안 된 LOT」이라
  //    잔액 행이 **아직 없다** — 뒤집으면 출고 전기가 깎을 행이 없어 본길이 400 으로 죽는다.
  //    그리고 이 순서라야 아래 `resolveSources` 가 그 행을 찾는다.
  const expedited = input.expedited === true;
  if (expedited) await postExpeditedReceipt(tx, posting, write);

  const sources = await resolveSources(tx, write);

  // ⭐ 품질 게이트는 잔액을 잠근 «뒤·전기 앞»이다 — 앞에 두면 잠금 없이 읽은 상태로 판정하고,
  //   뒤에 두면 이미 깎은 재고를 되돌린다. 계약 「Release 가 아니면 400」(결정 10).
  assertLotsReleased(
    sources.map((source) => ({ lotId: source.lotId, statusCode: source.statusCode })),
    (lotId) => pathOfLot(input, lotId),
  );

  const issue = await tx.goods_issue.create({
    data: {
      goods_issue_no: write.goodsIssueNo,
      issue_type_code: ISSUE_TYPE,
      source_document_type_code: SOURCE_DOCUMENT_TYPE,
      source_document_id: BigInt(input.shipmentRequestId),
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
        // ⭐ 이 값이 «피킹 소진의 축»이다 — `CONSUMES_PICKED` 에 있어야 `picked_qty` 가 내려간다.
        sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
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

  return writeShipment(tx, write, issueLines);
}

/**
 * ⭐⭐ **긴급 직행의 «제품 입고»** — 계약이 「참이면 서버가 제품 입고 전표와 입고 전기를 같은
 * 트랜잭션에서 함께 만든다」로 못 박았다(`W-04-05`).
 *
 * ⛔ **적치 지시를 만들지 않는다**(`putawayNos: null`) — 창고 경유를 건너뛰는 경로라 물건이
 * 그대로 나간다. 지시를 만들면 현장이 `W-01-12` 에서 유령 작업을 본다.
 * ⭐ 입고 위치는 출고가 쓸 위치와 **같은 값**이어야 한다 — 다르면 입고분이 유령 잔액으로 남는다.
 * 그래서 한 변수(`write.receiptLocationId`)를 둘에 넘긴다.
 * ⭐ 품질 축은 `NORMAL` 이다 — 품질 게이트가 이미 「Release 만」을 통과시켰다(그 LOT 은 정상이다).
 */
async function postExpeditedReceipt(
  tx: Tx,
  posting: InventoryPostingService,
  write: ShipmentWrite,
): Promise<void> {
  const { input } = write;
  const locationId = write.receiptLocationId;
  const receiptNo = write.goodsReceiptNo;
  if (locationId === undefined || receiptNo === undefined) {
    throw new Error('긴급 직행인데 입고 번호·위치가 없다 — 서비스가 안 풀었다.');
  }
  const flat = flatten(input);
  const lots = await tx.lot.findMany({
    where: { lot_id: { in: [...new Set(flat.map((entry) => BigInt(entry.allocation.lotId)))] } },
    select: { lot_id: true, item_id: true },
  });
  const itemByLot = new Map(lots.map((lot) => [lot.lot_id.toString(), lot.item_id]));

  await postReceipt(
    tx,
    posting,
    {
      receiptTypeCode: RECEIPT_TYPE,
      plantId: Number((await tx.warehouse.findUniqueOrThrow({
        where: { warehouse_id: BigInt(input.warehouseId) },
        select: { plant_id: true },
      })).plant_id),
      warehouseId: input.warehouseId,
      receiptDatetime: input.occurredAt,
      // ⭐ 서버가 정한 두 값 — 통보 221. 원천 id 는 «출하작업지시»가 아니라 이 출하가 아직
      //   없으므로(출하 행은 전기 뒤에 선다) 지시 id 를 싣는다. 짝을 비우면 A-10 이 깨진다.
      sourceDocumentTypeCode: RECEIPT_SOURCE,
      sourceDocumentId: input.shipmentRequestId,
      businessDate: input.businessDate,
      lines: flat.map((entry) => ({
        itemId: Number(itemByLot.get(String(entry.allocation.lotId)) ?? 0n),
        lotId: entry.allocation.lotId,
        receiptQty: entry.allocation.allocatedQty,
        uomId: entry.allocation.uomId,
        qualityStatusCode: QUALITY_NORMAL,
        inventoryStatusCode: INVENTORY_AVAILABLE,
        destinationLocationId: Number(locationId),
      })),
    },
    write.appUserId,
    receiptNo,
    // ⛔ `null` — 적치 지시 0건. 빈 배열이면 NOT NULL 위반 500 이다.
    null,
  );
}

/** 출하 헤더 · 라인 · 배분 + 되짚기 한 칸. 전기 «뒤»다 — 되짚을 출고 라인 id 가 필요하다. */
async function writeShipment(
  tx: Tx,
  write: ShipmentWrite,
  issueLines: GoodsIssueLineWriteInput[],
): Promise<bigint> {
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

  let cursor = 0;
  for (const [index, line] of input.lines.entries()) {
    const created = await tx.shipment_line.create({
      data: {
        shipment_id: shipment.shipment_id,
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
  return shipment.shipment_id;
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
async function resolveSources(tx: Tx, write: ShipmentWrite): Promise<Source[]> {
  const { input } = write;
  const errors: ErrorItem[] = [];
  const sources: Source[] = [];
  const lotIds = [...new Set(flatten(input).map((entry) => entry.allocation.lotId))];
  const lots = await tx.lot.findMany({
    where: { lot_id: { in: lotIds.map((id) => BigInt(id)) } },
    select: { lot_id: true, item_id: true, status_code: true },
  });
  const lotById = new Map(lots.map((lot) => [lot.lot_id.toString(), lot]));

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
