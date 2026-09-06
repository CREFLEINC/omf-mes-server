import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DOCUMENT_STATUS,
  InboundReceiptCreateInput,
  InboundReceiptHeaderWriteInput,
  InboundReceiptLineWriteInput,
  MATERIAL_LOT_TYPE,
  assertWritable,
  attachesLot,
  dayOrNull,
} from './inbound-receipt-rules';
import {
  InboundReceiptDetail,
  inboundReceiptLineView,
  inboundReceiptView,
} from './inbound-receipt-view';

/**
 * 입하 등록 — 화면 `M-01-01`. 「입하·라인·자재 LOT 이 **한 트랜잭션**으로 만들어진다」
 * (계약 · 공유계약 B-8). ⛔ 원장을 지나지 않는다 — 재고를 지는 것은 입고다.
 */
@Injectable()
export class InboundReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly lots: LotRegistryService,
  ) {}

  async create(
    input: InboundReceiptCreateInput,
    appUserId: number,
  ): Promise<{ detail: InboundReceiptDetail; versionNo: number }> {
    await assertWritable(this.prisma, input);

    // ⛔ 채번은 `$transaction` 을 «열기 전»에 부른다 — 잠근 채로 채번하면 카운터 대기가
    //    부모 P/O 잠금을 물고 늘어진다(I-3.md §3-2 · I-2 R-2).
    const inboundReceiptNo = await this.numbering.next(
      'INBOUND_RECEIPT',
      BigInt(input.plantId),
      input.businessDate,
    );

    const inboundReceiptId = await this.prisma.$transaction(
      (tx) => this.createWithin(tx, inboundReceiptNo, input, appUserId),
      // ⚠ 저장소 첫 트랜잭션 옵션이다 — 부모 P/O 잠금이 커밋까지 가므로 기본 5초를
      //   넘기면 `P2028` 이 «알려진 오류가 아니라» 500 으로 샌다(R-4).
      { timeout: 15_000, maxWait: 5_000 },
    );

    return this.read(Number(inboundReceiptId));
  }

  /**
   * 헤더·라인·LOT·P/O 귀속 한 벌. `:split` 이 **같은 `$transaction` 안에서 이것을 두 번**
   * 불러 정량분·초과분을 세운다 — 「부분 실패를 허용하지 않는다」(계약 · I-3.md §4-1).
   * ⛔ 채번은 여기서 하지 않는다 — 잠근 채로 채번하면 카운터 대기가 P/O 잠금을 문다.
   * `at` 은 오류가 짚을 계약 필드 경로의 앞머리다(등록 `''` · 분리 `'normal.'`·`'excess.'`).
   */
  async createWithin(
    tx: Prisma.TransactionClient,
    inboundReceiptNo: string,
    input: InboundReceiptHeaderWriteInput,
    appUserId: number,
    at = '',
  ): Promise<bigint> {
    const deltas = await this.lockAttribution(tx, input.lines, at);
    const inspection = await inspectionFlags(tx, input.lines);

    const header = await tx.inbound_receipt.create({
      data: {
        inbound_receipt_no: inboundReceiptNo,
        supplier_id: input.supplierId,
        plant_id: input.plantId,
        receipt_datetime: new Date(input.receiptDatetime),
        delivery_note_no: input.deliveryNoteNo ?? null,
        vehicle_no: input.vehicleNo ?? null,
        dock_location_id: input.dockLocationId ?? null,
        exception_type_code: input.exceptionTypeCode ?? null,
        exception_reason: input.exceptionReason ?? null,
        remarks: input.remarks ?? null,
        status_code: DOCUMENT_STATUS,
        // 요청 스키마에 `receivedBy` 칸이 없다 — 주체는 계정 세션이다(`X-Worker-No` 는
        // 덧붙임이라 없어도 400 이 아니다 · I-3.md §6-4).
        received_by: BigInt(appUserId),
        created_by: BigInt(appUserId),
      },
    });

    for (const [index, line] of input.lines.entries()) {
      const created = await tx.inbound_receipt_line.create({
        data: {
          inbound_receipt_id: header.inbound_receipt_id,
          // lineNo 는 배열 순서로 서버가 부여한다(계약 `uq_inbound_receipt_line`).
          line_no: index + 1,
          purchase_order_line_id: bigintOrNull(line.purchaseOrderLineId),
          asn_line_id: bigintOrNull(line.asnLineId),
          item_id: line.itemId,
          received_qty: line.receivedQty,
          uom_id: line.uomId,
          package_count: line.packageCount ?? null,
          supplier_lot_no: line.supplierLotNo ?? null,
          supplier_lot_missing: line.supplierLotMissing,
          substitute_lot_reason_code: line.substituteLotReasonCode ?? null,
          manufactured_date: dayOrNull(`${at}lines.${index}.manufacturedDate`, line.manufacturedDate),
          expiry_date: dayOrNull(`${at}lines.${index}.expiryDate`, line.expiryDate),
          inspection_required: inspection.get(BigInt(line.itemId)) ?? false,
          status_code: DOCUMENT_STATUS,
          created_by: BigInt(appUserId),
        },
      });

      if (!attachesLot(line)) continue;
      // ⛔ `POST /trace/lots` 를 HTTP 로 부르지 않는다 — 같은 `tx` 안에 서야 한다. 라인의
      //    `lot_id` 는 코어가 채운다(직접 UPDATE 하지 않는다 · R-1). ⛔ `manufactured_at`
      //    은 비운다 — 날짜를 시각으로 올리는 타임존 캐스팅이다(I-3.md §5-1).
      await this.lots.createWithin(
        tx,
        {
          lotNo: line.supplierLotNo as string,
          itemId: line.itemId,
          lotTypeCode: MATERIAL_LOT_TYPE,
          plantId: input.plantId,
          initialQty: line.receivedQty,
          uomId: line.uomId,
          expiryDate: line.expiryDate ?? null,
          sourceTypeCode: 'INBOUND_RECEIPT_LINE',
          sourceId: Number(created.inbound_receipt_line_id),
        },
        appUserId,
      );
    }

    for (const [purchaseOrderLineId, delta] of deltas) {
      await tx.purchase_order_line.update({
        where: { purchase_order_line_id: purchaseOrderLineId },
        data: { received_qty: { increment: delta.qty }, updated_by: BigInt(appUserId) },
      });
    }
    return header.inbound_receipt_id;
  }

  /**
   * 라인 → 부모 P/O 매핑을 읽고 부모를 오름차순 한 문장으로 잠근다. ⛔ 없는 라인을 «던지지
   * 않는다» — 400 이 짚을 필드 경로는 부르는 쪽만 안다. `:split` 은 `createWithin` 둘을
   * 부르기 «전»에 두 part 의 합집합으로 이것을 한 번 부른다.
   */
  async lockParentsOf(
    tx: Prisma.TransactionClient,
    purchaseOrderLineIds: bigint[],
  ): Promise<Map<bigint, bigint>> {
    // ⛔ 잠글 부모는 트랜잭션 «안»에서 라인 → 부모 매핑을 읽어 얻는다. 없는 라인을 FK 에
    //    맡기면 오류가 최상위 칸을 짚는다(R-6 ⓐ · #193 Minor-1).
    const owners = await tx.purchase_order_line.findMany({
      where: { purchase_order_line_id: { in: purchaseOrderLineIds } },
      select: { purchase_order_line_id: true, purchase_order_id: true },
    });
    const parents = new Map(owners.map((row) => [row.purchase_order_line_id, row.purchase_order_id]));
    if (parents.size === 0) return parents;

    const parentIds = [...new Set(parents.values())].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    await tx.$queryRaw`
      SELECT purchase_order_id
        FROM logistics.purchase_order
       WHERE purchase_order_id IN (${Prisma.join(parentIds)})
       ORDER BY purchase_order_id
         FOR UPDATE`;
    return parents;
  }

  /**
   * ⭐ 불변식 — `purchase_order_line.received_qty` 를 쓰는 모든 경로는 부모 `purchase_order`
   * 를 «먼저» 잠근다(I-3.md §3-2 · I-2 `replaceLines` 와 같은 순서). 두 입하가 서로 다른
   * 순서로 두 P/O 를 잡으면 교착하므로 **오름차순 한 문장**이다. `:split` 은 두 part 의
   * 합집합을 먼저 잠근다(PR ⑥) — part 마다 잠그면 순서가 어긋난다.
   */
  private async lockAttribution(
    tx: Prisma.TransactionClient,
    lines: InboundReceiptLineWriteInput[],
    at: string,
  ): Promise<Map<bigint, { qty: Prisma.Decimal; index: number }>> {
    const deltas = new Map<bigint, { qty: Prisma.Decimal; index: number }>();
    for (const [index, line] of lines.entries()) {
      if (line.purchaseOrderLineId == null) continue;
      const key = BigInt(line.purchaseOrderLineId);
      const carried = deltas.get(key);
      deltas.set(key, {
        qty: (carried?.qty ?? new Prisma.Decimal(0)).plus(line.receivedQty),
        index: carried?.index ?? index,
      });
    }
    if (deltas.size === 0) return deltas;

    const parents = await this.lockParentsOf(tx, [...deltas.keys()]);
    for (const [purchaseOrderLineId, delta] of deltas) {
      if (!parents.has(purchaseOrderLineId)) {
        throw one(
          field(`${at}lines.${delta.index}.purchaseOrderLineId`, ERROR_CODE.INVALID, '없는 P/O 라인입니다.'),
        );
      }
    }

    // 잠근 «뒤»에 수량을 다시 읽는다 — 그 전에 읽은 값은 P/O 치환이 바꿨을 수 있다.
    const locked = await tx.purchase_order_line.findMany({
      where: { purchase_order_line_id: { in: [...deltas.keys()] } },
      select: {
        purchase_order_line_id: true,
        ordered_qty: true,
        tolerance_over_qty: true,
        received_qty: true,
      },
    });
    for (const row of locked) {
      const delta = deltas.get(row.purchase_order_line_id);
      if (delta === undefined) continue;
      // ⛔ `Decimal` 로 비교한다 — `Number()` 로 접으면 `@db.Decimal(20,6)` 의 끝자리에서
      //    판정이 갈리고 `ck_po_line_received` 가 500 으로 샌다(I-3.md §3-3).
      const room = row.ordered_qty.plus(row.tolerance_over_qty).minus(row.received_qty);
      if (delta.qty.greaterThan(room)) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field(
            `${at}lines.${delta.index}.receivedQty`,
            ERROR_CODE.QTY_EXCEEDS_ORDERED,
            '발주 수량과 허용치를 넘습니다.',
          ),
        ]);
      }
    }
    return deltas;
  }

  private async read(
    inboundReceiptId: number,
  ): Promise<{ detail: InboundReceiptDetail; versionNo: number }> {
    const row = await this.prisma.inbound_receipt.findUniqueOrThrow({
      where: { inbound_receipt_id: inboundReceiptId },
    });
    const lines = await this.prisma.inbound_receipt_line.findMany({
      where: { inbound_receipt_id: inboundReceiptId },
      orderBy: { line_no: 'asc' },
    });
    return {
      detail: {
        inboundReceipt: inboundReceiptView(row),
        lines: lines.map(inboundReceiptLineView),
      },
      versionNo: row.version_no,
    };
  }
}

/** 「서버가 채운다 — 요청 스키마에 이 칸이 없다」(계약)이고 계약이 지목한 후보 하나가
 *  `Item.inspectionRequired` 다. 라인 치환도 같은 승계를 써야 해 내보낸다.
 *  ⚠ 판정 원천 미확정 — M-01-01 §8 #3. */
export async function inspectionFlags(
  tx: Prisma.TransactionClient,
  lines: InboundReceiptLineWriteInput[],
): Promise<Map<bigint, boolean>> {
  const rows = await tx.item.findMany({
    where: { item_id: { in: [...new Set(lines.map((line) => BigInt(line.itemId)))] } },
    select: { item_id: true, inspection_required: true },
  });
  return new Map(rows.map((row) => [row.item_id, row.inspection_required]));
}

function bigintOrNull(value: number | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}
