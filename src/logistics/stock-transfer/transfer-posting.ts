import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { BalanceLockKey, LockedBalanceRow, lockBalancesInOrder } from '../../core/inventory-posting/balance-lock';

/**
 * 재고 이동 «전기» — 한 문서가 원장을 **두 번** 남긴다(반출 · 도착). 두 전기가 한
 * 트랜잭션에 드는 자리는 없다 — 사이에 작업자가 물건을 들고 이동하는 시간이 있다.
 *
 * ⛔ HTTP 층을 모른다. `issue-posting.ts` 의 잠금·손검사 형상을 따르되 피킹 소진과
 * `assertLotNotBlocked` 는 없다 — 이동은 피킹 축이 아니고, 보류 LOT 이동은 화면
 * `M-01-10` §5-3 이 「경고 + 진행 가능」(✓확정 결정 14)으로 열어 둔 정상 경로다.
 */

/** 원장 판별자 4값 중 하나. 유형 값 목록이 0건이라 같은 값을 유형에도 쓴다(입고·출고·적치 선례). */
const SOURCE_DOCUMENT_TYPE = 'STOCK_TRANSFER';
const POSTED = 'POSTED';
/**
 * ⭐ 반출이 갈아 끼우는 **유일한** 축이다. 적치·출고는 「품질·재고 상태를 바꾸지 않는다」로
 * 못 박았는데(`putaway-posting.ts:52-53`) 여기가 그 예외다 — 근거 셋: `plan-integration.md:324`
 * · 시드 `INVENTORY_STATUS.IN_TRANSIT` 실재 · 이동 중인 물건이 도착 창고에서 「가용」으로
 * 보이면 안 된다.
 */
const IN_TRANSIT = 'IN_TRANSIT';
/** 둘째 원장의 번호 접미. `-R` 은 역처리가 이미 쓴다(`reversal.ts`) — 도착은 `-A` 다. */
const ARRIVE_NO_SUFFIX = '-A';

type Tx = Prisma.TransactionClient;

export interface TransferLineWriteInput {
  /** 되짚기 대상 — 서비스가 라인을 만든 뒤 그 id 를 실어 부른다. */
  stockTransferLineId: bigint;
  itemId: bigint;
  lotId: bigint;
  qty: Prisma.Decimal;
  uomId: bigint;
  fromLocationId: bigint;
  toLocationId: bigint;
  /** A4 로 선 칸. 원장 라인(`PostingLine.handlingUnitId`)에 그대로 넘긴다. */
  handlingUnitId: bigint | null;
}

export interface PostTransferIssueInput {
  stockTransferId: bigint;
  stockTransferNo: string;
  fromWarehouseId: bigint;
  toWarehouseId: bigint;
  lines: TransferLineWriteInput[];
  /** ⛔ 본문 값 그대로다 — 서버가 수신 시각으로 다시 잡지 않는다(C-8 · CLAUDE.md). */
  businessDate: string;
  /** 반출 스캔 시각(C-1). */
  occurredAt: Date;
}

/** 조직 축은 **끝점 창고마다 따로** 푼다 — 두 창고의 법인·사업장·공장이 갈릴 수 있다. */
type OrgAxis = Omit<BalanceLockKey, 'locationId' | 'itemId' | 'lotKey'>;

const ZERO = new Prisma.Decimal(0);

const keyOf = (k: BalanceLockKey): string =>
  `${k.legalEntityId}:${k.businessUnitId}:${k.plantId}:${k.warehouseId}:${k.locationId}:${k.itemId}:${k.lotKey}`;

/**
 * 반출 전기 — 출발 위치에서 빼서 **{도착 창고, 계획 도착 위치, `IN_TRANSIT`}** 에 세운다.
 *
 * ⭐ 이동 «중»에는 물건이 어느 위치에도 없는데 `inventory_balance.location_id` 가 NOT NULL
 * 이라 자리를 정해야 한다. 계획 도착 위치를 미리 쓴다 — 새 개념이 0 이고, 「아직 도착 안
 * 했다」는 `inventory_status_code = IN_TRANSIT` 가 말한다(I-13.md §3-4).
 *
 * 돌려주는 것은 전표 라인이 되짚을 원장 라인 id 들(요청 순서)이다.
 */
export async function postTransferIssue(
  tx: Tx,
  posting: InventoryPostingService,
  input: PostTransferIssueInput,
  appUserId: number | undefined,
): Promise<bigint[]> {
  const { lines } = input;
  const source = await orgAxis(tx, input.fromWarehouseId);
  const destination = await orgAxis(tx, input.toWarehouseId);
  const dim = (line: TransferLineWriteInput, locationId: bigint) => ({
    locationId,
    itemId: line.itemId,
    lotKey: line.lotId,
  });
  const fromKeys = lines.map((line) => ({ ...source, ...dim(line, line.fromLocationId) }));

  // ⭐ `from` 과 `to` 를 «같은» 문장에 넣는다 — 밖에 두면 `move()` 가 순서 밖에서 잡아
  //    A→B·B→A 동시 이동이 교착한다(I-4.md R-1 ②). 코어 헬퍼가 그 한 문장이다.
  const locked = await lockBalancesInOrder(tx, [
    ...fromKeys,
    ...lines.map((line) => ({ ...destination, ...dim(line, line.toLocationId) })),
  ]);
  const found = new Map<string, LockedBalanceRow[]>();
  for (const row of locked) found.set(keyOf(row), [...(found.get(keyOf(row)) ?? []), row]);

  // ⛔ 같은 (위치·품목·LOT) 라인이 둘이면 라인별 검사는 둘 다 통과하고 둘째 UPDATE 에서
  //    트리거가 500 을 낸다 — 키별 «합계»로 본다(I-4.md R-1 ③).
  const demanded = new Map<string, { qty: Prisma.Decimal; index: number }>();
  for (const [index, key] of fromKeys.entries()) {
    const seen = demanded.get(keyOf(key));
    demanded.set(keyOf(key), {
      qty: (seen?.qty ?? ZERO).plus(lines[index].qty),
      index: seen?.index ?? index,
    });
  }

  const errors: ErrorItem[] = [];
  const picked = new Map<string, LockedBalanceRow>();
  for (const [id, { qty, index }] of demanded) {
    const rows = found.get(id) ?? [];
    const at = `lines[${index}]`;
    if (rows.length === 0) {
      errors.push(field(`${at}.lotId`, ERROR_CODE.NEGATIVE_BALANCE, '이 위치에 그 LOT 의 재고가 없습니다.'));
    } else if (rows.length > 1) {
      // 설계 미정 — 문의 031. 계약이 품질·재고 상태 칸을 안 실어 어느 잔액을 깎을지 모른다.
      errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '재고 차원이 둘 이상이라 어느 것을 낼지 정할 수 없습니다.'));
    } else if (rows[0].available_qty === null) {
      // ⛔ 생성 컬럼인데 Prisma 타입이 `Decimal?` 이다 — 조용히 0 으로 두지 않고 던진다.
      throw new Error(`available_qty 가 비어 있다: inventory_balance ${id}`);
    } else if (rows[0].available_qty.lessThan(qty)) {
      errors.push(field(`${at}.requestedQty`, ERROR_CODE.NEGATIVE_BALANCE, '보유 수량보다 많이 옮길 수 없습니다.'));
    } else {
      picked.set(id, rows[0]);
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const posted = await posting.post(tx, {
    businessDate: input.businessDate,
    occurredAt: input.occurredAt,
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    // 전표 번호를 그대로 원장 번호로 쓴다(3선례). 도착은 `-A` 를 붙인다.
    transactionNo: input.stockTransferNo,
    statusCode: POSTED,
    // 헤더에 `plant_id` 가 없다 — 출발 창고에서 푼다.
    plantId: Number(source.plantId),
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: Number(input.stockTransferId),
    // ⭐ 헤더값이 아니라 «결정적» 키다. 도착은 `:ARRIVE` 라 같은 영업일에도 안 부딪힌다.
    idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${input.stockTransferNo}:ISSUE`,
    createdBy: appUserId,
    lines: lines.map((line, index) => {
      // ⚠ 품질·소유 축은 계약이 안 싣는 칸이라 «잠근 잔액 행»에서 되읽는다(문의 031).
      const from = picked.get(keyOf(fromKeys[index])) as LockedBalanceRow;
      return {
        itemId: Number(line.itemId),
        lotId: Number(line.lotId),
        qty: Number(line.qty),
        uomId: Number(line.uomId),
        from: {
          warehouseId: Number(input.fromWarehouseId),
          locationId: Number(line.fromLocationId),
          qualityStatusCode: from.quality_status_code,
          inventoryStatusCode: from.inventory_status_code,
        },
        to: {
          warehouseId: Number(input.toWarehouseId),
          locationId: Number(line.toLocationId),
          qualityStatusCode: from.quality_status_code,
          inventoryStatusCode: IN_TRANSIT,
        },
        ownershipTypeCode: from.ownership_type_code,
        ...(from.owner_partner_id === null ? {} : { ownerPartnerId: Number(from.owner_partner_id) }),
        ...(line.handlingUnitId === null ? {} : { handlingUnitId: Number(line.handlingUnitId) }),
      };
    }),
  });
  // 흡수가 오면 잔액은 안 옮겨졌는데 되짚기가 그대로 돈다 — 조용히 지나느니 되돌린다.
  if (posted.alreadyPosted) throw new Error(`원장이 이미 있다: ${input.stockTransferNo}`);

  return ledgerLineIds(tx, posted.inventoryTransactionId, input.businessDate, lines.length);
}

/**
 * 되짚을 원장 라인 id 를 «자리»로 짝짓는다 — posting 이 넘긴 배열 순서대로 `line_no` 를
 * 매긴다는 코어 규약에 기댄다(반환 순서 추정이 아니다).
 * ⛔ 길이가 다르면 던진다 — 어긋나면 전표 라인이 «남의 원장»을 가리킨다.
 */
async function ledgerLineIds(
  tx: Tx,
  inventoryTransactionId: bigint,
  businessDate: string,
  expected: number,
): Promise<bigint[]> {
  const ledger = await tx.inventory_transaction_line.findMany({
    where: {
      inventory_transaction_id: inventoryTransactionId,
      business_date: new Date(`${businessDate}T00:00:00.000Z`),
    },
    orderBy: { line_no: 'asc' },
    select: { inventory_transaction_line_id: true },
  });
  if (ledger.length !== expected) {
    throw new Error(`원장 라인 수가 이동 라인과 다르다: ${ledger.length} ≠ ${expected}`);
  }
  return ledger.map((row) => row.inventory_transaction_line_id);
}

/** 잔액 행의 조직 축 셋은 창고가 안다 — 이동 헤더에는 `plant_id` 조차 없다. */
async function orgAxis(tx: Tx, warehouseId: bigint): Promise<OrgAxis> {
  const warehouse = await tx.warehouse.findUniqueOrThrow({
    where: { warehouse_id: warehouseId },
    select: { business_unit_id: true, plant_id: true, plant: { select: { legal_entity_id: true } } },
  });
  return {
    legalEntityId: warehouse.plant.legal_entity_id,
    businessUnitId: warehouse.business_unit_id,
    plantId: warehouse.plant_id,
    warehouseId,
  };
}

/**
 * 도착 끝점 — 반출 원장 라인의 `to_*` 4칸 + 라인 3칸을 **그대로 복제**한 것이다. 끝점을
 * 지어내면 반출이 세운 잔액 «행»이 아닌 다른 차원을 깎아 `NEGATIVE_BALANCE` 가 난다.
 *
 * ⭐ `restoredInventoryStatusCode` = 반출 원장 라인의 `from_inventory_status_code` — 도착이
 * **되돌릴** 재고 상태다. ⛔ `AVAILABLE` 로 고정하지 않는다: 화면 `M-01-10` §5-3 이 보류 LOT
 * 이동을 「경고 + 진행 가능」으로 열어 `ON_HOLD` 출발이 실제로 도달하는데, 고정하면 서버가
 * 보류 재고를 이동 한 번으로 가용으로 **세탁**한다(결정 — 통보 125).
 */
export interface TransferArriveOrigin {
  warehouseId: bigint; locationId: bigint; qualityStatusCode: string;
  /** 반출이 세운 값 — `IN_TRANSIT` 이다. */
  inventoryStatusCode: string;
  restoredInventoryStatusCode: string;
  ownershipTypeCode: string; ownerPartnerId: bigint | null; handlingUnitId: bigint | null;
}

export interface TransferArriveLineInput {
  /** 오류 자리를 가리킬 **본문** 번호 — 0 수량 라인을 걸러 넘겨 배열 자리와 다르다. */
  lineIndex: number;
  itemId: bigint; lotId: bigint; uomId: bigint;
  /** 본문 `receivedQty` — 0 인 라인은 호출자가 걸러 넘긴다(원장 `qty > 0` CHECK). */
  qty: Prisma.Decimal;
  origin: TransferArriveOrigin;
  /** 최종 도착 위치 — 본문 재정의가 있으면 그 값이다. */
  toLocationId: bigint;
}

export interface PostTransferArriveInput {
  stockTransferId: bigint; stockTransferNo: string; toWarehouseId: bigint;
  lines: TransferArriveLineInput[]; businessDate: string; occurredAt: Date;
}

/** 잠금 키 7칸 + 잔액 유일 인덱스가 갖는 나머지 4칸. */
const dimOf = (
  k: BalanceLockKey, quality: string, inventory: string, ownership: string, owner: bigint | null,
): string => `${keyOf(k)}:${quality}:${inventory}:${ownership}:${owner ?? ''}`;

/**
 * 도착 전기 — **{도착 창고, 계획 위치, `IN_TRANSIT`}** 에서 빼서 실제 도착 위치에 세운다.
 * 두 끝점이 다 도착 창고 안이라 조직 3축이 하나다.
 */
export async function postTransferArrive(
  tx: Tx, posting: InventoryPostingService, input: PostTransferArriveInput, appUserId: number | undefined,
): Promise<bigint[]> {
  const { lines } = input;
  const axis = await orgAxis(tx, input.toWarehouseId);
  const dim = (line: TransferArriveLineInput, locationId: bigint) => ({
    ...axis, locationId, itemId: line.itemId, lotKey: line.lotId,
  });
  const fromKeys = lines.map((line) => dim(line, line.origin.locationId));
  const locked = await lockBalancesInOrder(tx, [
    ...fromKeys, ...lines.map((line) => dim(line, line.toLocationId)),
  ]);

  // ⭐ 잠금 키 7칸은 품질·재고 상태·소유를 **안 가른다** — 반출 원장이 준 11칸으로 «고른다».
  //    반출의 「행이 둘이면 400」(문의 031) 갈래를 여기 쓰면, 앞서 도착해 이미 선 잔액이 같은
  //    7칸에 함께 걸려 **같은 품목·LOT 의 두 번째 이동이 언제나 400** 이 된다.
  const found = new Map(
    locked.map((row) => [
      dimOf(row, row.quality_status_code, row.inventory_status_code, row.ownership_type_code, row.owner_partner_id),
      row,
    ]),
  );
  const ids = lines.map(({ origin }, index) =>
    dimOf(fromKeys[index], origin.qualityStatusCode, origin.inventoryStatusCode,
      origin.ownershipTypeCode, origin.ownerPartnerId));

  // ⚠ 반출이 세운 잔액이라 모자랄 수 없다 — 그래도 본다(잔여를 누가 먼저 빼 갔을 수 있다).
  //    같은 차원의 라인이 둘이면 «합계»로 봐야 둘째 UPDATE 에서 트리거가 500 을 안 낸다.
  const need = new Map<string, Prisma.Decimal>();
  for (const [index, id] of ids.entries()) need.set(id, (need.get(id) ?? ZERO).plus(lines[index].qty));
  const errors: ErrorItem[] = ids.flatMap((id, index) => {
    const available = found.get(id)?.available_qty ?? null;
    return available !== null && !available.lessThan(need.get(id) as Prisma.Decimal)
      ? []
      : [field(`lines[${lines[index].lineIndex}].receivedQty`, ERROR_CODE.NEGATIVE_BALANCE,
          '운송중 수량보다 많이 받을 수 없습니다.')];
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const posted = await posting.post(tx, {
    businessDate: input.businessDate,
    occurredAt: input.occurredAt,
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    // ⭐ 한 문서가 원장을 «둘» 남긴다 — 같은 영업일에 `uq_inventory_transaction_no` 를 안 깨려면
    //    둘째에 접미가 있어야 한다.
    transactionNo: `${input.stockTransferNo}${ARRIVE_NO_SUFFIX}`,
    statusCode: POSTED,
    plantId: Number(axis.plantId),
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: Number(input.stockTransferId),
    idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${input.stockTransferNo}:ARRIVE`,
    createdBy: appUserId,
    lines: lines.map(({ origin, ...line }) => ({
      itemId: Number(line.itemId), lotId: Number(line.lotId),
      qty: Number(line.qty), uomId: Number(line.uomId),
      from: {
        warehouseId: Number(origin.warehouseId), locationId: Number(origin.locationId),
        qualityStatusCode: origin.qualityStatusCode,
        inventoryStatusCode: origin.inventoryStatusCode,
      },
      to: {
        warehouseId: Number(origin.warehouseId), locationId: Number(line.toLocationId),
        // ⛔ 품질 상태는 손대지 않는다 — 이동은 판정이 아니다(적치·출고 선례).
        qualityStatusCode: origin.qualityStatusCode,
        inventoryStatusCode: origin.restoredInventoryStatusCode,
      },
      ownershipTypeCode: origin.ownershipTypeCode,
      ...(origin.ownerPartnerId === null ? {} : { ownerPartnerId: Number(origin.ownerPartnerId) }),
      ...(origin.handlingUnitId === null ? {} : { handlingUnitId: Number(origin.handlingUnitId) }),
    })),
  });
  if (posted.alreadyPosted) throw new Error(`도착 원장이 이미 있다: ${input.stockTransferNo}`);
  return ledgerLineIds(tx, posted.inventoryTransactionId, input.businessDate, lines.length);
}
