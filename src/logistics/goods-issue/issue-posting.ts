import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import type { ConsumeMove } from '../../core/inventory-posting';

/**
 * 출고 «전기» — 잔액 선잠금 · 음수 손검사 · 원장 out · 되짚기. 입고 `receipt-posting.ts` 의
 * **거울상**이다(입고는 `to` 만, 출고는 `from` 만 싣는다).
 *
 * ⛔ HTTP 층을 모른다 — 헤더·라인·계정 id 를 받는다. `:post`(`goods-issue.service.ts`)와
 * 등록의 `postImmediately` 경로(PR ④)가 **같은 트랜잭션 안에서** 이것을 부른다. 그래서
 * 헤더 잠금·승인 게이트·상태 전이는 여기 없다 — 그 셋은 `:post` 에만 있는 일이다.
 *
 * ⛔ **`inventory.lock_balance(...)` 헬퍼(baseline:3225)를 쓰지 않는다** — 행마다 한 번
 * 도는 모양이라 라인 N 개면 왕복 N 회다. 아래 한 문장이 같은 일을 한 번에 한다.
 *
 * ⭐⭐ **I-23(출하)이 이것을 «부른다»** — I-4 가 자기 파일에 적어 둔 「I-23 은 타입만
 * `import type` 한다」를 I-23 이 실측으로 뒤집었다(I-23.md §3-2 ⓓ 정정 · PR ④b):
 *   ⓐ 그 금지의 근거였던 `server-architecture.md:67`(「도메인이 다른 도메인의 service 를
 *      부르지 않는다」)은 **이 자리에 성립하지 않는다** — 출하·출고는 **둘 다 `logistics`** 고
 *      `postIssue` 는 service 가 아니라 **export 함수**다.
 *   ⓑ 안 부르면 「잔액 선잠금 · 키별 합계 · 피킹 소진 · 손검사 · 원장 · 되짚기」 ~150줄을
 *      복제해야 하고, 그중 **조용히 갈릴 자리가 셋**이다(같은 키 두 라인의 합계 · STORED 인
 *      `available_qty` 가 소진 뒤에도 옛 값인 것 · 차원 2행+ 판정).
 *   ⇒ 이 함수의 머리 주석이 이미 「`:post` 와 등록의 `postImmediately` 경로가 **같은
 *      트랜잭션 안에서** 이것을 부른다」라 다중 호출자를 설계로 적어 두었다. 셋째가 온 것이다.
 */

/** ⭐ 원장 판별자 4값 중 하나다 — 전표의 `source_document_type_code`(피킹·입고·처분)가 아니다. */
const SOURCE_DOCUMENT_TYPE = 'GOODS_ISSUE';
const POSTED = 'POSTED';
const SUPPLIER_RETURN = 'SUPPLIER_RETURN';
const GOODS_RECEIPT = 'GOODS_RECEIPT';
const PUTAWAY_PENDING = 'PENDING';
const PUTAWAY_CANCELLED = 'CANCELLED';
/** 도착지가 위치일 때만 원장 라인에 `to` 가 실린다 — 나머지는 나가서 없어진다. */
const DESTINATION_LOCATION = 'LOCATION';

/** I-23 이 재사용하는 «데이터 모양». 서비스도 `postIssue()` 도 넘기지 않는다. */
export interface GoodsIssueHeaderWriteInput {
  goodsIssueId: bigint;
  goodsIssueNo: string;
  issueTypeCode: string;
  /** ⭐ 피킹 소진의 **축**이다 — `'PICKING_ORDER'` 면 라인 «전건»이 소진 대상이다(I-8.md R-4). */
  sourceDocumentTypeCode: string;
  sourceDocumentId: bigint;
  sourceWarehouseId: bigint;
  destinationTypeCode: string | null;
  destinationId: bigint | null;
}

export interface GoodsIssueLineWriteInput {
  /** 되짚기(§3-5) 대상. 등록 경로는 라인을 만든 뒤 그 id 를 실어 부른다. */
  goodsIssueLineId: bigint;
  itemId: bigint;
  lotId: bigint;
  issueQty: Prisma.Decimal;
  uomId: bigint;
  sourceLocationId: bigint;
  /**
   * 되짚기용 «선택» 칸이다 — 계약 `GoodsIssueLineUpsert` required 5 에 없어 화면이 비울 수
   * 있다. ⛔ 소진 축으로 쓰지 않는다: 비면 `consume()` 이 안 돌고 손검사가 피킹분을 뺀
   * `available` 로 재어 **정상 출고가 400** 이 된다(I-8.md R-4).
   */
  pickingLineId?: bigint | null;
}

export interface PostIssueInput {
  header: GoodsIssueHeaderWriteInput;
  lines: GoodsIssueLineWriteInput[];
  /** ⛔ 본문 값 그대로다 — 서버가 수신 시각으로 다시 잡지 않는다(C-8 · CLAUDE.md). */
  businessDate: string;
  /** ⛔ 본문 값 그대로다(C-1). 입고와 달리 `issued_at` 을 쓰지 않는다 — 본문이 직접 준다. */
  occurredAt: Date;
}

/** 잔액 차원 7칸 — `uq_inventory_balance_dim` 11칸 중 출고 라인이 «주는» 쪽이다. */
interface BalanceKey {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
  warehouseId: bigint;
  locationId: bigint;
  itemId: bigint;
  /** `COALESCE(lot_id, 0)` — 표현식 유일 인덱스와 같은 축이라 null 을 0 으로 접는다. */
  lotKey: bigint;
}

interface BalanceRow extends BalanceKey {
  quality_status_code: string;
  inventory_status_code: string;
  ownership_type_code: string;
  owner_partner_id: bigint | null;
  on_hand_qty: Prisma.Decimal;
  available_qty: Prisma.Decimal | null;
}

type Tx = Prisma.TransactionClient;

const keyOf = (k: BalanceKey): string =>
  `${k.legalEntityId}:${k.businessUnitId}:${k.plantId}:${k.warehouseId}:${k.locationId}:${k.itemId}:${k.lotKey}`;

/**
 * 라인마다 `from` 하나(+도착이 위치면 `to`). 잔액을 먼저 «한 문장으로» 잠그고 손검사한
 * 뒤에 원장을 연다 — 순서가 불변식이다.
 */
export async function postIssue(
  tx: Tx,
  posting: InventoryPostingService,
  input: PostIssueInput,
  appUserId: number | undefined,
): Promise<void> {
  const { header, lines } = input;
  await assertLotNotBlocked(tx, lines);

  const source = await orgAxis(tx, header.sourceWarehouseId);
  const fromKeys = lines.map((line) => ({ ...source, ...dimensionOf(line, line.sourceLocationId) }));
  const destination = await destinationAxis(tx, header);
  const toKeys =
    destination === null
      ? []
      : lines.map((line) => ({ ...destination.org, ...dimensionOf(line, destination.locationId) }));

  const balances = await lockBalances(tx, [...fromKeys, ...toKeys]);
  const found = groupByKey(balances);
  // ⛔ 같은 (위치·품목·LOT) 라인이 둘이면 라인별 검사는 둘 다 통과하고 둘째 UPDATE 에서
  //    트리거가 500 을 낸다 — 키별 «합계»로 본다(I-4.md R-1 ③).
  const demanded = new Map<string, { qty: Prisma.Decimal; index: number }>();
  for (const [index, key] of fromKeys.entries()) {
    const id = keyOf(key);
    const seen = demanded.get(id);
    // 오류를 짚을 자리는 그 키를 «처음» 쓴 라인이다 — 같은 키에 두 번 담지 않는다.
    demanded.set(id, { qty: (seen?.qty ?? new Prisma.Decimal(0)).plus(lines[index].issueQty), index: seen?.index ?? index });
  }

  const errors: ErrorItem[] = [];
  const picked = new Map<string, BalanceRow>();
  for (const [id, { index }] of demanded) {
    const rows = found.get(id) ?? [];
    if (rows.length === 0) {
      errors.push(
        field(`lines[${index}].lotId`, ERROR_CODE.NEGATIVE_BALANCE, '이 위치에 그 LOT 의 재고가 없습니다.'),
      );
      continue;
    }
    if (rows.length > 1) {
      // 설계 미정 — 문의 031. 계약이 품질·재고 상태 칸을 안 실어 어느 잔액을 깎을지 모른다.
      errors.push(
        field(`lines[${index}].lotId`, ERROR_CODE.INVALID, '재고 차원이 둘 이상이라 어느 것을 낼지 정할 수 없습니다.'),
      );
      continue;
    }
    const row = rows[0];
    // ⛔ 생성 컬럼인데 Prisma 타입이 `Decimal?` 이다 — null 이면 조용히 0 으로 두지 않고 던진다.
    if (row.available_qty === null) {
      throw new Error(`available_qty 가 비어 있다: inventory_balance ${id}`);
    }
    picked.set(id, row);
  }
  // ⭐ 판정 오류는 소진 «전»에 낸다 — 없는 행을 소진하려 들면 코어가 다른 400 을 던진다.
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const consumed = await consumePicked(tx, posting, input, fromKeys, picked);

  for (const [id, { qty, index }] of demanded) {
    const row = picked.get(id) as BalanceRow;
    // ⛔ `on_hand_qty` 만 보면 안 된다 — 트리거 첫 갈래가 「on_hand < reserved+picked+blocked」도
    //    막아 예약이 걸린 재고를 내면 500 이다. ⛔ `item.negative_stock_allowed` 는 보지 않는다 —
    //    계약 `GoodsIssueLineUpsert.issueQty` 가 「보유 수량 이하」로 예외 없이 닫았다(§3-3).
    // ⭐ `available_qty` 는 STORED 생성 컬럼이라 `consume()` 뒤에도 «옛 값»이다 — 되읽기 대신
    //    방금 내린 소진량을 더한다(같은 트랜잭션이고 행은 잠겨 있다 · I-8.md R-6).
    if ((row.available_qty as Prisma.Decimal).plus(consumed.get(id) ?? ZERO).lessThan(qty)) {
      errors.push(
        field(`lines[${index}].issueQty`, ERROR_CODE.NEGATIVE_BALANCE, '보유 수량보다 많이 낼 수 없습니다.'),
      );
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const posted = await posting.post(tx, {
    businessDate: input.businessDate,
    occurredAt: input.occurredAt,
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    // 전표 번호를 그대로 원장 번호로 쓴다(입고 선례) — 두 표를 사람이 맞대 볼 수 있다.
    transactionNo: header.goodsIssueNo,
    statusCode: POSTED,
    // 헤더에 `plant_id` 가 없다 — 출발 창고에서 푼다(I-4.md §8-3 ⓖ).
    plantId: Number(source.plantId),
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: Number(header.goodsIssueId),
    // 등록의 `postImmediately` 경로와 «같은» 키다. 전표 번호가 유일하고 키가 거기서 나오므로
    // 흡수는 «앞 전기가 이미 커밋됐다»는 뜻이고, 그때 헤더는 POSTED 라 상태 잠금이 먼저 막는다.
    idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${header.goodsIssueNo}`,
    createdBy: appUserId,
    lines: lines.map((line, index) => {
      const from = picked.get(keyOf(fromKeys[index])) as BalanceRow;
      return {
        itemId: Number(line.itemId),
        lotId: Number(line.lotId),
        qty: Number(line.issueQty),
        uomId: Number(line.uomId),
        // 출발지만 있고 도착지가 없다 — 그것이 「나갔다」의 표현이다.
        from: {
          warehouseId: Number(header.sourceWarehouseId),
          locationId: Number(line.sourceLocationId),
          // ⚠ 계약이 안 싣는 두 칸이라 «잠근 잔액 행»에서 되읽는다(§3-2 · 문의 031).
          qualityStatusCode: from.quality_status_code,
          inventoryStatusCode: from.inventory_status_code,
        },
        // ⭐ 도착 두 칸은 `from` 과 «같은 값»이다 — 이동에서 품질·재고 상태가 바뀌는 축이
        //    계약에 없다. 값을 바꾸지 않는 것이 조용히 도출하지 않는 쪽이다(§3-2).
        ...(destination === null
          ? {}
          : {
              to: {
                warehouseId: Number(destination.org.warehouseId),
                locationId: Number(destination.locationId),
                qualityStatusCode: from.quality_status_code,
                inventoryStatusCode: from.inventory_status_code,
              },
            }),
        ownershipTypeCode: from.ownership_type_code,
        ...(from.owner_partner_id === null ? {} : { ownerPartnerId: Number(from.owner_partner_id) }),
      };
    }),
  });

  // 그래도 흡수가 오면 잔액은 안 깎였는데 되짚기와 상태 전이가 그대로 돈다 — 조용히 지나느니 되돌린다.
  if (posted.alreadyPosted) {
    throw new Error(`원장이 이미 있다 — 상태 잠금을 지나쳤다: ${header.goodsIssueNo}`);
  }

  // posting 은 라인을 받은 «순서»대로 `line_no` 를 매긴다 — 자리로 짝짓는다(입고와 같은 모양).
  const ledger = await tx.inventory_transaction_line.findMany({
    where: {
      inventory_transaction_id: posted.inventoryTransactionId,
      business_date: new Date(`${input.businessDate}T00:00:00.000Z`),
    },
    orderBy: { line_no: 'asc' },
    select: { inventory_transaction_line_id: true },
  });
  // 어긋나면 라인이 «남의 원장»을 가리키게 된다 — 조용히 어긋나느니 되돌린다.
  if (ledger.length !== lines.length) {
    throw new Error(`원장 라인 수가 출고 라인과 다르다: ${ledger.length} ≠ ${lines.length}`);
  }
  for (const [index, line] of lines.entries()) {
    await tx.goods_issue_line.update({
      where: { goods_issue_line_id: line.goodsIssueLineId },
      data: { inventory_transaction_line_id: ledger[index].inventory_transaction_line_id },
    });
  }

  await cancelFullyReturnedPutawayTasks(tx, input, demanded, picked, appUserId);
}

/**
 * 공급사 전량 반품으로 출발 차원의 재고가 0이 되면 아직 시작하지 않은 적치 지시는 더 이상
 * 실행할 물건이 없다. 같은 원천 입고·LOT·위치의 PENDING 지시만 닫는다. 부분 반품과 이미
 * 완료한 지시는 건드리지 않는다.
 */
async function cancelFullyReturnedPutawayTasks(
  tx: Tx,
  input: PostIssueInput,
  demanded: Map<string, { qty: Prisma.Decimal; index: number }>,
  picked: Map<string, BalanceRow>,
  appUserId: number | undefined,
): Promise<void> {
  const { header } = input;
  if (header.issueTypeCode !== SUPPLIER_RETURN || header.sourceDocumentTypeCode !== GOODS_RECEIPT) {
    return;
  }

  const emptied = [...demanded.entries()].flatMap(([key, { qty, index }]) => {
    const balance = picked.get(key) as BalanceRow;
    if (!balance.on_hand_qty.equals(qty)) return [];
    const line = input.lines[index];
    return [{ lot_id: line.lotId, item_id: line.itemId, from_location_id: line.sourceLocationId }];
  });
  if (emptied.length === 0) return;

  await tx.putaway_task.updateMany({
    where: {
      status_code: PUTAWAY_PENDING,
      goods_receipt_line: { goods_receipt_id: header.sourceDocumentId },
      OR: emptied,
    },
    data: {
      status_code: PUTAWAY_CANCELLED,
      updated_by: appUserId == null ? null : BigInt(appUserId),
      version_no: { increment: 1 },
    },
  });
}

const ZERO = new Prisma.Decimal(0);

/**
 * ⭐ 피킹 소진의 축 — 출고 «헤더»의 원천 유형이다(I-8.md R-4).
 *
 * ⭐⭐ **둘이다**(I-23 PR ④b 가 `SHIPMENT` 를 더했다). 출하도 `:pick` 이 예약을 `picked_qty`
 * 로 옮겨 둔 뒤에 나가므로, 소진을 안 하면 손검사가 **피킹분을 뺀 `available`** 로 재어
 * **정상 출하가 언제나 400** 이다 — 피킹 출고와 «글자 그대로 같은» 사고다.
 * ⛔ 여기 없는 원천 유형(입고 반품·처분 폐기)은 피킹을 거치지 않아 소진 대상이 «아니다».
 */
const CONSUMES_PICKED: readonly string[] = ['PICKING_ORDER', 'SHIPMENT'];

/**
 * ⭐ **손검사 «앞»**에서 돈다 — `available = on_hand − reserved − picked − blocked` 라
 * 피킹된 재고는 가용에서 이미 빠져 있고, 그대로 두면 피킹을 마친 정상 출고가 언제나 400
 * `NEGATIVE_BALANCE` 다(I-8.md §3-5). `picked↓` → `on_hand↓` 순서라 트리거
 * `check_balance_qty()` 의 문장별 불변식도 지킨다(R-6).
 *
 * ⛔ 라인의 `pickingLineId` 축으로 «가르지» 않는다 — 헤더가 `PICKING_ORDER` 면 라인 전건이
 * 대상이다. ⚠ 피킹이 올린 행과 출고가 내리는 행이 다르면 코어가 0행 → 400 이고, 그것이
 * 옳다(다른 위치의 피킹분을 여기서 소진할 수 없다).
 *
 * 돌려주는 것은 «키별 소진 합»이다 — 손검사가 `available_qty` 에 더해 쓴다.
 */
async function consumePicked(
  tx: Tx,
  posting: InventoryPostingService,
  input: PostIssueInput,
  fromKeys: BalanceKey[],
  picked: Map<string, BalanceRow>,
): Promise<Map<string, Prisma.Decimal>> {
  const consumed = new Map<string, Prisma.Decimal>();
  if (!CONSUMES_PICKED.includes(input.header.sourceDocumentTypeCode)) return consumed;

  const moves: ConsumeMove[] = [];
  for (const [index, line] of input.lines.entries()) {
    const id = keyOf(fromKeys[index]);
    const row = picked.get(id) as BalanceRow;
    moves.push({
      dimension: {
        legalEntityId: row.legalEntityId,
        businessUnitId: row.businessUnitId,
        plantId: row.plantId,
        warehouseId: row.warehouseId,
        locationId: row.locationId,
        itemId: row.itemId,
        // ⚠ 사본의 SELECT 가 `COALESCE(lot_id,0)` 만 내린다 — 출고 라인은 `lot_id` NOT NULL 이라
        //    0 이 「LOT 없음」인 갈래가 서지 않는다(코어 `BalanceDimension.lotId` 는 실제 컬럼이다).
        lotId: row.lotKey === 0n ? null : row.lotKey,
        qualityStatusCode: row.quality_status_code,
        inventoryStatusCode: row.inventory_status_code,
        ownershipTypeCode: row.ownership_type_code,
        ownerPartnerId: row.owner_partner_id,
      },
      qty: line.issueQty,
      field: `lines[${index}].issueQty`,
    });
    consumed.set(id, (consumed.get(id) ?? ZERO).plus(line.issueQty));
  }
  await posting.consume(tx, moves);
  return consumed;
}

/**
 * 결정 10 의 단일 지점은 상태 문자열 집합이 아니라 **`mdm.judgment_type_control`** 이다
 * (공유계약 3163 · `blocksIssue`). 그 표에 `blocks_issue = true` 행이 있으면 막는다.
 *
 * ⛔ `{DEFECTIVE,SCRAPPED,…}` 를 코드에 박지 않는다 — 박으면 폐기(`W-01-06` 불량창고
 * 입고분)·반품(`W-01-05` IQC 불합격) 전건이 400 이 되어 계약이 정의한 업무가 사라진다.
 * ⚠ `JUDGMENT_TYPE` 값 목록이 0개라 **오늘은 아무것도 막지 않는다**(I-4.md §5-3).
 * ⛔ `trace.lot_hold` 는 보지 않는다 — 보류 기록은 `W-03-02` 소관이고 잔액 칸으로도 안
 * 내려온다(`contracts/quality-03품질.json:1845` 「`inventory_balance.blocked_qty` 는 쓰지
 * 않는다 — 잔액은 서버가 파생한다(L-2)」).
 */
async function assertLotNotBlocked(tx: Tx, lines: GoodsIssueLineWriteInput[]): Promise<void> {
  // 라인마다 돌지 않는다 — 요청의 distinct 상태값으로 한 번 본다(I-4.md R-7).
  const statuses = await tx.lot.findMany({
    where: { lot_id: { in: [...new Set(lines.map((line) => line.lotId))] } },
    select: { status_code: true },
    distinct: ['status_code'],
  });
  const blocked = await tx.judgment_type_control.findFirst({
    where: { blocks_issue: true, lot_status_code: { in: statuses.map((row) => row.status_code) } },
    select: { code_value_id: true },
  });
  if (blocked !== null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '출고가 막힌 LOT 이 있습니다.' },
    ]);
  }
}

/**
 * ⭐ **7칸 행생성자 한 문장**이다. `(plant,warehouse,location,item) = ANY(…) AND
 * COALESCE(lot_id,0) = ANY(…)` 로 쓰면 라인 1 의 위치와 라인 2 의 LOT 이 짝지어져(교차곱)
 * 0행/1행/2행+ 판정이 뭉개진다(I-4.md R-1 ①).
 *
 * ⭐ `ORDER BY inventory_balance_id … FOR UPDATE` — 두 출고가 서로 다른 순서로 같은 두
 * 행을 잡으면 교착한다. 도착(`LOCATION`) 차원도 «같은 문장»에 넣는다: 밖에 두면
 * `move()` 가 순서 밖에서 잡아 A→B·B→A 동시 출고가 정확히 이 처방이 막으려던 교착이 된다(R-1 ②).
 *
 * ⛔ 없는 행을 `ON CONFLICT DO NOTHING` 으로 만들어 두지 않는다 — 「재고가 없다」가
 * 「0 이 있다」로 바뀌어 0행 판정이 사라진다.
 */
async function lockBalances(tx: Tx, keys: BalanceKey[]): Promise<BalanceRow[]> {
  if (keys.length === 0) return [];
  const values = keys.map(
    (k) =>
      Prisma.sql`(${k.legalEntityId}::bigint, ${k.businessUnitId}::bigint, ${k.plantId}::bigint, ${k.warehouseId}::bigint, ${k.locationId}::bigint, ${k.itemId}::bigint, ${k.lotKey}::bigint)`,
  );
  return tx.$queryRaw<BalanceRow[]>`
    SELECT legal_entity_id      AS "legalEntityId",
           business_unit_id     AS "businessUnitId",
           plant_id             AS "plantId",
           warehouse_id         AS "warehouseId",
           location_id          AS "locationId",
           item_id              AS "itemId",
           COALESCE(lot_id, 0)  AS "lotKey",
           quality_status_code, inventory_status_code, ownership_type_code, owner_partner_id,
           on_hand_qty,
           available_qty
      FROM inventory.inventory_balance
     WHERE (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id,
            COALESCE(lot_id, 0))
           IN (VALUES ${Prisma.join(values)})
     ORDER BY inventory_balance_id
       FOR UPDATE`;
}

function groupByKey(rows: BalanceRow[]): Map<string, BalanceRow[]> {
  const grouped = new Map<string, BalanceRow[]>();
  for (const row of rows) {
    const id = keyOf(row);
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return grouped;
}

const dimensionOf = (
  line: GoodsIssueLineWriteInput,
  locationId: bigint,
): Pick<BalanceKey, 'locationId' | 'itemId' | 'lotKey'> => ({
  locationId,
  itemId: line.itemId,
  lotKey: line.lotId,
});

/** 잔액 행의 조직 축 셋은 창고가 안다 — 출고 헤더에는 `plant_id` 조차 없다. */
async function orgAxis(
  tx: Tx,
  warehouseId: bigint,
): Promise<Pick<BalanceKey, 'legalEntityId' | 'businessUnitId' | 'plantId' | 'warehouseId'>> {
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
 * 도착이 `LOCATION` 일 때만 선다. ⛔ 헤더가 도착 «창고»를 안 준다 — `mdm.location.warehouse_id`
 * 에서 읽는다. 입고가 「목적지는 그 창고의 위치여야 한다」를 손검사한 것의 반대 방향이라
 * 검사가 아니라 조회다(§3-1).
 */
async function destinationAxis(
  tx: Tx,
  header: GoodsIssueHeaderWriteInput,
): Promise<{ org: Awaited<ReturnType<typeof orgAxis>>; locationId: bigint } | null> {
  if (header.destinationTypeCode !== DESTINATION_LOCATION || header.destinationId === null) {
    return null;
  }
  const location = await tx.location.findUniqueOrThrow({
    where: { location_id: header.destinationId },
    select: { warehouse_id: true },
  });
  return {
    org: await orgAxis(tx, location.warehouse_id),
    locationId: header.destinationId,
  };
}
