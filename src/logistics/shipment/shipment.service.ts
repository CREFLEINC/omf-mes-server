import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveDestinationLocation } from '../destination-location';
import { ShipmentQueryService } from './shipment-query.service';
import { ShipmentCreateWrite, postShipment } from './shipment-posting';
import { assertAllocationSum, assertShipmentQty } from './shipment-rules';
import { ShipmentDetailView } from './shipment-view';

/**
 * 출하 등록(화면 `W-04-04`·`W-04-05`) — 「출하·라인·LOT 배분을 한 트랜잭션으로 만든다」.
 * ⛔ **확정하지 않는다** — 계약이 「미확정 출하까지이고 확정은 `:confirm` 이다」로 못 박았다.
 */

/** 번호가 «둘»이라 재시도가 둘 다를 새로 뽑는다(I-17 R-11 ⓓ 가 한 쪽만 적어 지적받은 자리). */
const NUMBER_RETRY = 3;

@Injectable()
export class ShipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly queries: ShipmentQueryService,
  ) {}

  async create(input: ShipmentCreateWrite, appUserId: number): Promise<ShipmentDetailView> {
    const axis = await this.assertWritable(input);
    for (let attempt = 1; ; attempt += 1) {
      try {
        // ⭐ 채번은 `$transaction` «밖»이다 — 카운터가 업무 트랜잭션에 걸리면 같은 (유형·영업일)
        //    출하가 전기·잔액까지 한 줄로 서고, 롤백이 번호를 되돌려 재시도가 같은 번호를 뽑는다.
        const [shipmentNo, goodsIssueNo, goodsReceiptNo] = await Promise.all([
          this.numbering.next('SHIPMENT', BigInt(axis.plantId), input.businessDate),
          this.numbering.next('GOODS_ISSUE', BigInt(axis.plantId), input.businessDate),
          // ⭐ 긴급 직행일 «때만» 셋째 번호를 뽑는다 — 평시엔 입고 전표가 0건이라 뽑으면 결번만 는다.
          input.expedited === true
            ? this.numbering.next('GOODS_RECEIPT', BigInt(axis.plantId), input.businessDate)
            : Promise.resolve(undefined),
        ]);
        const shipmentId = await this.prisma.$transaction(async (tx) => {
          const created = await postShipment(tx, this.posting, {
            input,
            shipmentNo,
            goodsIssueNo,
            goodsReceiptNo,
            receiptLocationId: axis.receiptLocationId,
            itemIdByLine: axis.itemIdByLine,
            appUserId,
          });
          await this.rollUp(tx, input);
          return created;
        });
        return (await this.queries.get(Number(shipmentId))).view;
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '출하 번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  /**
   * ⭐ 롤업 둘 — 출하작업지시 라인과 그 수주 라인의 `shipped_qty`.
   * ⛔ 둘 다 **CHECK 가 걸려 있다**(`ck_shipment_request_qty` · `ck_sales_shipped_qty`) — 넘치면
   * 500 이라 아래 `assertWritable` 이 **미리** 400 으로 막는다. 여기서는 더하기만 한다.
   * ⚠ 수주 라인은 **없을 수 있다**(`sales_order_line_id` 가 nullable) — 그때는 그 쪽만 건너뛴다.
   */
  private async rollUp(tx: Prisma.TransactionClient, input: ShipmentCreateWrite): Promise<void> {
    for (const line of input.lines) {
      const updated = await tx.shipment_request_line.update({
        where: { shipment_request_line_id: BigInt(line.shipmentRequestLineId) },
        data: { shipped_qty: { increment: line.shippedQty }, version_no: { increment: 1 } },
        select: { sales_order_line_id: true },
      });
      if (updated.sales_order_line_id === null) continue;
      await tx.sales_order_line.update({
        where: { sales_order_line_id: updated.sales_order_line_id },
        data: { shipped_qty: { increment: line.shippedQty }, version_no: { increment: 1 } },
      });
    }
  }

  /**
   * DB 왕복 «전»에 거를 수 있는 것을 먼저 거르고, 그 뒤 마스터 실재와 **수량 한도 둘**을 본다.
   * ⭐ 서버가 정하는 축 둘을 여기서 역산해 돌려준다 — 공장은 창고에서, 라인의 품목은
   * `shipment_request_line` 에서(본문에 `itemId` 가 0개다 · §6).
   */
  private async assertWritable(
    input: ShipmentCreateWrite,
  ): Promise<{ plantId: number; itemIdByLine: bigint[]; receiptLocationId?: bigint }> {
    assertExpedite(input);
    assertShipmentQty(input.lines);
    assertAllocationSum(input.lines);

    const lineIds = input.lines.map((line) => BigInt(line.shipmentRequestLineId));
    const [warehouse, request, lines] = await Promise.all([
      this.prisma.warehouse.findFirst({
        where: { warehouse_id: BigInt(input.warehouseId), is_active: true },
        select: { plant_id: true, management_level_code: true },
      }),
      this.prisma.shipment_request.findUnique({
        where: { shipment_request_id: BigInt(input.shipmentRequestId) },
        select: { shipment_request_id: true },
      }),
      this.prisma.shipment_request_line.findMany({
        where: { shipment_request_line_id: { in: lineIds } },
        select: {
          shipment_request_line_id: true,
          shipment_request_id: true,
          item_id: true,
          allocated_qty: true,
          shipped_qty: true,
          sales_order_line: { select: { ordered_qty: true, shipped_qty: true } },
        },
      }),
    ]);

    const errors: ErrorItem[] = [];
    if (warehouse === null) {
      errors.push(field('warehouseId', ERROR_CODE.INVALID, '쓸 수 있는 창고가 아닙니다.'));
    }
    if (request === null) {
      errors.push(field('shipmentRequestId', ERROR_CODE.INVALID, '없는 출하작업지시입니다.'));
    }
    const byId = new Map(lines.map((line) => [line.shipment_request_line_id.toString(), line]));
    const itemIdByLine: bigint[] = [];
    for (const [index, line] of input.lines.entries()) {
      const found = byId.get(String(line.shipmentRequestLineId));
      if (found === undefined) {
        errors.push(
          field(`lines[${index}].shipmentRequestLineId`, ERROR_CODE.INVALID, '없는 지시 라인입니다.'),
        );
        continue;
      }
      // ⛔ 남의 지시 라인을 실으면 롤업이 «다른 지시»의 수량을 올린다 — 본문 헤더와 맞춘다.
      if (found.shipment_request_id !== BigInt(input.shipmentRequestId)) {
        errors.push(
          field(`lines[${index}].shipmentRequestLineId`, ERROR_CODE.INVALID, '이 출하작업지시의 라인이 아닙니다.'),
        );
        continue;
      }
      itemIdByLine.push(found.item_id);
      const shipped = new Prisma.Decimal(line.shippedQty);
      // ⛔ `ck_shipment_request_qty(S ≤ A ≤ R)` 를 앞당긴다 — DB 가 내면 500 이다.
      if (found.shipped_qty.plus(shipped).greaterThan(found.allocated_qty)) {
        errors.push(
          field(`lines[${index}].shippedQty`, ERROR_CODE.RANGE, '배정 수량보다 많이 낼 수 없습니다.'),
        );
      }
      const order = found.sales_order_line;
      // ⛔ `ck_sales_shipped_qty(shipped ≤ ordered)` 도 같다. ⚠ 수주 라인은 없을 수 있다.
      if (order !== null && order.shipped_qty.plus(shipped).greaterThan(order.ordered_qty)) {
        errors.push(
          field(`lines[${index}].shippedQty`, ERROR_CODE.RANGE, '수주 수량보다 많이 낼 수 없습니다.'),
        );
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    const found = warehouse as { plant_id: bigint; management_level_code: string };
    return {
      plantId: Number(found.plant_id),
      itemIdByLine,
      ...(input.expedited === true
        ? {
            // ⭐ 재등록(PR ⑧)과 «같은» 해소기다 — 계약 「창고면 위치를 받지 않고, 셀이면 셀까지 받는다」.
            //   ⛔ 긴급 직행은 본문에 위치 칸이 0개라 더 깊게 관리하는 창고면 창고 칸에 400 REQUIRED 다.
            receiptLocationId: await resolveDestinationLocation(this.prisma, {
              warehouseId: input.warehouseId,
              managementLevelCode: found.management_level_code,
              warehouseField: 'warehouseId',
            }),
          }
        : {}),
    };
  }
}

/**
 * ⭐ 「`expedited` 가 참이면 사유가 필수」는 **계약 `required` 에 없다** — 설명문(공유계약 A-12)에만
 * 있어 계약 검증 가드가 안 본다. ⇒ 손검사가 진다. 물리 `ck_shipment_expedite` 도 같은 짝을 보지만
 * 그쪽이 내면 **500** 이다.
 */
function assertExpedite(input: ShipmentCreateWrite): void {
  if (input.expedited !== true) return;
  const reason = input.expediteReason;
  if (reason === undefined || reason === null || reason.trim() === '') {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('expediteReason', ERROR_CODE.REQUIRED, '긴급 직행은 사유가 필요합니다.'),
    ]);
  }
}

/**
 * `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다.
 * ⭐ 번호가 **둘**이다(출하·출고). `transaction_no` 는 원장이 출고 번호를 그대로 쓰는 자리다.
 */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  const columns = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return columns.some((column) =>
    ['shipment_no', 'goods_issue_no', 'goods_receipt_no', 'transaction_no'].some((name) =>
      column.includes(name),
    ),
  );
}
