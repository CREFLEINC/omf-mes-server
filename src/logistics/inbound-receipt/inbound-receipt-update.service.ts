import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DOCUMENT_STATUS,
  InboundReceiptLineWriteInput,
  dayOrNull,
  supplierLotLabelAttached,
} from './inbound-receipt-rules';
import {
  InboundReceiptLineView,
  InboundReceiptView,
  inboundReceiptLineView,
  inboundReceiptView,
} from './inbound-receipt-view';
import { inspectionFlags } from './inbound-receipt.service';

/** 1↔2 맞바꾸기가 `uq_inbound_receipt_line` 을 «중간 상태»에서 깬다 — 한 문장으로 밀어 두고 최종
 *  1..N 을 다시 준다. `CHECK (line_no > 0)` 이라 음수로는 못 민다(P/O `replaceLines` 선례). */
const LINE_NO_SHIFT = 1_000_000;

/** 부모 P/O 잠금이 커밋까지 간다 — 기본 5초를 넘기면 `P2028` 이 500 으로 샌다(I-3.md R-4). */
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/** ⛔ `plantId`·`statusCode`·`exceptionTypeCode`·`exceptionReason`·`receivedBy` 는 계약
 *  `InboundReceiptUpdate` 에 칸이 없다 — 실려 와도 손대지 않는다. */
export interface InboundReceiptUpdateInput {
  supplierId: number;
  receiptDatetime: string;
  deliveryNoteNo?: string | null;
  vehicleNo?: string | null;
  dockLocationId?: number | null;
  remarks?: string | null;
}

/** 한 P/O 라인에 걸리는 차분. 옛 라인만 기여했으면 짚을 요청 칸이 없어 `index` 가 빈다. */
interface Attribution {
  qty: Prisma.Decimal;
  index?: number;
}

type ExistingLine = Pick<
  Prisma.inbound_receipt_lineGetPayload<object>,
  'inbound_receipt_line_id' | 'purchase_order_line_id' | 'received_qty' | 'lot_id'
>;

/** 입하 헤더 수정 + 라인 치환. 등록은 `InboundReceiptService`, 조회는 `InboundReceiptQueryService`. */
@Injectable()
export class InboundReceiptUpdateService {
  constructor(private readonly prisma: PrismaService) {}

  /** 「작성중 상태에서만 허용한다」(계약). 값 목록에 「작성중」이 없어 `REGISTERED` 하나로 푼다(P/O
   *  `update` 선례). ⛔ 1차엔 그 값 밖으로 옮기는 오퍼레이션이 없어 e2e 로 못 세운다(§7-2 · 문의 026). */
  async update(
    inboundReceiptId: number,
    version: number,
    input: InboundReceiptUpdateInput,
    appUserId: number,
  ): Promise<{ inboundReceipt: InboundReceiptView; versionNo: number }> {
    const current = await this.prisma.inbound_receipt.findUnique({
      where: { inbound_receipt_id: inboundReceiptId },
      select: { status_code: true },
    });
    if (!current) throw new NotFoundException('없는 입하입니다.');
    assertRegistered(current.status_code, '수정할');
    if (Number.isNaN(Date.parse(input.receiptDatetime))) {
      throw one(field('receiptDatetime', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
    }

    const updated = await this.prisma.inbound_receipt.updateMany({
      where: { inbound_receipt_id: inboundReceiptId, version_no: version },
      data: {
        supplier_id: input.supplierId,
        receipt_datetime: new Date(input.receiptDatetime),
        // 전체 치환이라 생략 = 비움이다(P/O `update` 선례).
        delivery_note_no: input.deliveryNoteNo ?? null,
        vehicle_no: input.vehicleNo ?? null,
        dock_location_id: input.dockLocationId ?? null,
        remarks: input.remarks ?? null,
        updated_by: BigInt(appUserId),
        version_no: { increment: 1 },
      },
    });
    // 존재는 위에서 확인했다 — 0행이면 그 사이 값이 바뀐 것이다(재로드로 풀린다).
    assertUpdated(updated.count);
    const where = { inbound_receipt_id: inboundReceiptId };
    const row = await this.prisma.inbound_receipt.findUniqueOrThrow({ where });
    return {
      inboundReceipt: inboundReceiptView(row),
      versionNo: row.version_no,
    };
  }

  /** ⭐ 순서가 불변식이다 — 부모 `inbound_receipt` 버전 범프 → 부모 `purchase_order` 오름차순
   *  `FOR UPDATE` → `inbound_receipt_line` 쓰기. 뒤집으면 P/O 라인 치환(부모 잠금 → 라인 DELETE 의
   *  RI 잠금이 입하 라인을 잡는다)과 교착한다(R-6 ⓒ).
   *  ⛔ LOT 을 만들지 않는다 — `supplierLotNo` 가 실려도 LOT 은 등록·`:split` 의 일이다(§5-1).
   *  ⛔ 응답에 ETag 가 없다(계약이 헤더 미선언). 그래도 부모 `version_no` 는 올린다 — 다음
   *  If-Match 는 상세 GET 이 준다(§6-3). */
  async replaceLines(
    inboundReceiptId: number,
    version: number,
    items: InboundReceiptLineWriteInput[],
    appUserId: number,
  ): Promise<InboundReceiptLineView[]> {
    assertItems(items);
    const group = 'SUBSTITUTE_LOT_REASON';
    const codes = items.map((item, index) => ({
      field: `items.${index}.substituteLotReasonCode`,
      value: item.substituteLotReasonCode,
      groupCode: group,
    }));
    await assertCodeValues(this.prisma, codes);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.inbound_receipt.findUnique({
        where: { inbound_receipt_id: inboundReceiptId },
        select: { status_code: true },
      });
      if (!current) throw new NotFoundException('없는 입하입니다.');
      assertRegistered(current.status_code, '라인을 고칠');
      const bumped = await tx.inbound_receipt.updateMany({
        where: { inbound_receipt_id: inboundReceiptId, version_no: version },
        data: { version_no: { increment: 1 }, updated_by: BigInt(appUserId) },
      });
      assertUpdated(bumped.count);

      const existing: ExistingLine[] = await tx.inbound_receipt_line.findMany({
        where: { inbound_receipt_id: inboundReceiptId },
        select: {
          inbound_receipt_line_id: true,
          purchase_order_line_id: true,
          received_qty: true,
          lot_id: true,
        },
      });
      const known = new Map(existing.map((row) => [Number(row.inbound_receipt_line_id), row]));
      assertOwnLines(items, known);
      // 계약 「요청에서 빠진 기존 행은 삭제한다」.
      const requested = new Set(items.map((item) => item.inboundReceiptLineId));
      const gone = existing.filter((row) => !requested.has(Number(row.inbound_receipt_line_id)));
      // 「이미 LOT 이 만들어진 라인은 삭제할 수 없다 — 400 STATE_LOCKED」(계약이 코드까지 적었다).
      if (gone.some((row) => row.lot_id !== null)) {
        throw one(banner(ERROR_CODE.STATE_LOCKED, 'LOT 이 만들어진 라인은 지울 수 없습니다.'));
      }
      const removed = gone.map((row) => row.inbound_receipt_line_id);
      await assertNoSuccessor(tx, [...removed, ...changed(items, known)]);
      await this.applyAttribution(tx, attributionsOf(existing, items), appUserId);
      await this.writeLines(tx, inboundReceiptId, items, removed, appUserId);

      const rows = await tx.inbound_receipt_line.findMany({
        where: { inbound_receipt_id: inboundReceiptId },
        orderBy: { line_no: 'asc' },
      });
      return rows.map(inboundReceiptLineView);
    }, TRANSACTION_OPTIONS);
  }

  /** ⭐ 불변식 — `purchase_order_line.received_qty` 를 쓰는 모든 경로는 부모 `purchase_order` 를
   *  «먼저» 잠근다(§3-2). 잠글 부모는 «옛 집합 ∪ 새 집합»이다 — 내리는 쪽을 빼면 그 P/O 의
   *  손검사가 남의 트랜잭션과 겹친다. */
  private async applyAttribution(
    tx: Prisma.TransactionClient,
    attributions: Map<bigint, Attribution>,
    appUserId: number,
  ): Promise<void> {
    if (attributions.size === 0) return;
    const lineIds = [...attributions.keys()];
    // ⛔ 잠글 부모는 트랜잭션 «안»에서 라인 → 부모 매핑을 읽어 얻는다 — FK 에 맡기면 오류가
    //    최상위 칸을 짚는다(R-6 ⓐ).
    const owners = await tx.purchase_order_line.findMany({
      where: { purchase_order_line_id: { in: lineIds } },
      select: { purchase_order_line_id: true, purchase_order_id: true },
    });
    const parents = new Map(owners.map((row) => [row.purchase_order_line_id, row.purchase_order_id]));
    for (const [purchaseOrderLineId, delta] of attributions) {
      if (parents.has(purchaseOrderLineId)) continue;
      throw one(at(delta.index, 'purchaseOrderLineId', ERROR_CODE.INVALID, '없는 P/O 라인입니다.'));
    }
    const ascending = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0);
    await tx.$queryRaw`
      SELECT purchase_order_id
        FROM logistics.purchase_order
       WHERE purchase_order_id IN (${Prisma.join([...new Set(parents.values())].sort(ascending))})
       ORDER BY purchase_order_id
         FOR UPDATE`;

    // 잠근 «뒤»에 수량을 다시 읽는다 — 그 전에 읽은 값은 P/O 치환이 바꿨을 수 있다.
    const locked = await tx.purchase_order_line.findMany({
      where: { purchase_order_line_id: { in: lineIds } },
      select: {
        purchase_order_line_id: true,
        ordered_qty: true,
        tolerance_over_qty: true,
        received_qty: true,
      },
    });
    for (const row of locked) {
      const delta = attributions.get(row.purchase_order_line_id);
      if (delta === undefined) continue;
      // ⛔ `Decimal` 로 비교한다 — `Number()` 로 접으면 끝자리에서 판정이 갈리고 CHECK 위반이 500 으로
      //    샌다(§3-3). 하한은 `app.qty_t` 의 `CHECK (VALUE >= 0)` 다 — 조용히 0 으로 깎지 않는다(R-5).
      const next = row.received_qty.plus(delta.qty);
      if (next.lessThan(0)) {
        throw one(at(delta.index, 'receivedQty', ERROR_CODE.RANGE, '누적 입하 수량이 0 미만이 됩니다.'));
      }
      if (next.greaterThan(row.ordered_qty.plus(row.tolerance_over_qty))) {
        const code = ERROR_CODE.QTY_EXCEEDS_ORDERED;
        throw one(at(delta.index, 'receivedQty', code, '발주 수량과 허용치를 넘습니다.'));
      }
      if (delta.qty.isZero()) continue;
      await tx.purchase_order_line.update({
        where: { purchase_order_line_id: row.purchase_order_line_id },
        data: {
          received_qty: { increment: delta.qty },
          updated_by: BigInt(appUserId),
        },
      });
    }
  }

  private async writeLines(
    tx: Prisma.TransactionClient,
    inboundReceiptId: number,
    items: InboundReceiptLineWriteInput[],
    removed: bigint[],
    appUserId: number,
  ): Promise<void> {
    if (removed.length > 0) {
      await tx.inbound_receipt_line.deleteMany({
        where: { inbound_receipt_line_id: { in: removed } },
      });
    }
    await tx.$executeRaw`
      UPDATE logistics.inbound_receipt_line
         SET line_no = line_no + ${LINE_NO_SHIFT}
       WHERE inbound_receipt_id = ${BigInt(inboundReceiptId)}`;

    const inspection = await inspectionFlags(tx, items);
    for (const [index, item] of items.entries()) {
      const values = {
        // lineNo 는 배열 순서로 서버가 부여한다(요청이 보내지 않는다 · 등록과 같은 축).
        line_no: index + 1,
        purchase_order_line_id: item.purchaseOrderLineId ?? null,
        asn_line_id: item.asnLineId ?? null,
        item_id: item.itemId,
        received_qty: item.receivedQty,
        uom_id: item.uomId,
        package_count: item.packageCount ?? null,
        supplier_lot_no: item.supplierLotNo ?? null,
        supplier_lot_missing: item.supplierLotMissing,
        supplier_lot_label_attached: supplierLotLabelAttached(item),
        substitute_lot_reason_code: item.substituteLotReasonCode ?? null,
        manufactured_date: dayOrNull(`items.${index}.manufacturedDate`, item.manufacturedDate),
        expiry_date: dayOrNull(`items.${index}.expiryDate`, item.expiryDate),
        inspection_required: inspection.get(BigInt(item.itemId)) ?? false,
      };
      if (item.inboundReceiptLineId === undefined) {
        const owner = {
          inbound_receipt_id: inboundReceiptId,
          status_code: DOCUMENT_STATUS,
        };
        await tx.inbound_receipt_line.create({
          data: { ...owner, created_by: BigInt(appUserId), ...values },
        });
        continue;
      }
      // ⛔ `lot_id`·`status_code` 는 안 건드린다 — LOT 은 등록·`:split` 의 일이고 라인 상태는 값
      //    목록이 없어 판정에 안 쓴다(§5-1·§5-4).
      await tx.inbound_receipt_line.update({
        where: { inbound_receipt_line_id: item.inboundReceiptLineId },
        data: { ...values, updated_by: BigInt(appUserId) },
      });
    }
  }
}

function assertRegistered(statusCode: string, action: string): void {
  if (statusCode === DOCUMENT_STATUS) return;
  throw one(field('statusCode', ERROR_CODE.STATE_LOCKED, `작성중 상태에서만 ${action} 수 있습니다.`));
}

function assertItems(items: InboundReceiptLineWriteInput[]): void {
  // 계약이 「최소 1행」이라 적었으나 `minItems` 를 안 걸어 가드가 빈 배열을 통과시킨다.
  if (items.length === 0) {
    throw one(field('items', ERROR_CODE.LINE_REQUIRED, '입하 라인이 1건 이상이어야 합니다.'));
  }
  const errors: ErrorItem[] = [];
  for (const [index, item] of items.entries()) {
    // 「`supplierLotMissing` 이 참일 때 필수」(계약) — 등록(`inbound-receipt-rules.ts`)과 같은 코드다.
    if (item.supplierLotMissing && !item.substituteLotReasonCode) {
      errors.push(field(`items.${index}.substituteLotReasonCode`, ERROR_CODE.PAIR, '대체 LOT 사유가 필요합니다.'));
    }
    // ⛔ `ck_inbound_expiry` 위반은 알려진 오류가 아니라 500 으로 샌다 — 손으로 앞당긴다.
    if (item.expiryDate && item.manufacturedDate && item.expiryDate < item.manufacturedDate) {
      errors.push(field(`items.${index}.expiryDate`, ERROR_CODE.INVALID, '제조일보다 앞설 수 없습니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** 짚는 행이 «없거나»(남의 입하) «둘 이상 겹치면» 조용한 사고가 된다 — 겹치면 같은 행에 `update`
 *  가 두 번 걸려 요청 N 건이 응답 N-1 건으로 줄고도 200 이다(#194 Major-1). */
function assertOwnLines(items: InboundReceiptLineWriteInput[], known: Map<number, ExistingLine>): void {
  const seen = new Set<number>();
  for (const [index, item] of items.entries()) {
    const lineId = item.inboundReceiptLineId;
    if (lineId === undefined) continue;
    const name = `items.${index}.inboundReceiptLineId`;
    if (!known.has(lineId)) throw one(field(name, ERROR_CODE.INVALID, '이 입하의 라인이 아닙니다.'));
    if (seen.has(lineId)) throw one(field(name, ERROR_CODE.INVALID, '같은 라인을 두 번 실었습니다.'));
    seen.add(lineId);
  }
}

/** 삭제·수량 변경·귀속 대상 변경 셋을 한 맵으로 처리한다 — 옛 기여분을 되돌리지 않으면 누적
 *  입하가 영원히 부풀어 오른다(§3-1). */
function attributionsOf(existing: ExistingLine[], items: InboundReceiptLineWriteInput[]): Map<bigint, Attribution> {
  const attributions = new Map<bigint, Attribution>();
  const add = (key: bigint | null, qty: Prisma.Decimal | number, index?: number): void => {
    if (key === null) return;
    const carried = attributions.get(key);
    const sum = (carried?.qty ?? new Prisma.Decimal(0)).plus(qty);
    attributions.set(key, { qty: sum, index: carried?.index ?? index });
  };
  for (const row of existing) add(row.purchase_order_line_id, row.received_qty.negated());
  for (const [index, item] of items.entries()) {
    add(item.purchaseOrderLineId == null ? null : BigInt(item.purchaseOrderLineId), item.receivedQty, index);
  }
  return attributions;
}

/** 수량이 달라진 «기존» 라인 — 삭제와 같은 자물쇠를 받는다(§7-4). */
function changed(items: InboundReceiptLineWriteInput[], known: Map<number, ExistingLine>): bigint[] {
  const ids: bigint[] = [];
  for (const { inboundReceiptLineId: lineId, receivedQty } of items) {
    const row = lineId === undefined ? undefined : known.get(lineId);
    if (row && !row.received_qty.equals(receivedQty)) ids.push(BigInt(lineId as number));
  }
  return ids;
}

/** 계약이 LOT 만 적었다 — 입고·차이·역참조 P/O 도 막는다(I-3.md §7-4). 안 막으면 FK 위반이 500
 *  으로 새고, 수량만 고치면 원장이 가리키는 근거가 조용히 달라진다. 「전기 완료」 축이 서면
 *  걷어낼 임시 자물쇠다(문의 026). */
async function assertNoSuccessor(tx: Prisma.TransactionClient, lineIds: bigint[]): Promise<void> {
  if (lineIds.length === 0) return;
  const where = { inbound_receipt_line_id: { in: lineIds } };
  const successors =
    (await tx.goods_receipt_line.count({ where })) +
    (await tx.inbound_variance.count({ where })) +
    (await tx.purchase_order.count({
      where: { source_inbound_receipt_line_id: { in: lineIds } },
    }));
  if (successors > 0) {
    throw one(banner(ERROR_CODE.SUCCESSOR_EXISTS, '입고·차이가 붙은 라인은 지우거나 수량을 바꿀 수 없습니다.'));
  }
}

/** 옛 라인만 기여한 차분에는 짚을 요청 칸이 없다 — 그때는 배너다(공유계약 G-1). */
function at(index: number | undefined, name: string, code: string, message: string): ErrorItem {
  return index === undefined ? banner(code, message) : field(`items.${index}.${name}`, code, message);
}

function banner(code: string, message: string): ErrorItem {
  return { scope: 'screen', code, message };
}
