import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { optionalDate } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseOrderQueryService } from './purchase-order-query.service';
import { PurchaseOrderDetail, PurchaseOrderView, purchaseOrderView } from './purchase-order-view';

export interface PurchaseOrderLineWriteInput {
  /** 있어도 무시한다 — 등록은 언제나 신규 라인이다(계약이 허용한 칸이라 400 으로 막지
   *  않는다. I-2.md R-8 ⓑ). */
  purchaseOrderLineId?: number;
  itemId: number;
  orderedQty: number;
  uomId: number;
  toleranceOverQty?: number;
  toleranceUnderQty?: number;
}

export interface PurchaseOrderCreateInput {
  supplierId: number;
  businessUnitId: number;
  plantId: number;
  orderDate: string;
  expectedReceiptDate?: string | null;
  sourceInboundReceiptLineId?: number | null;
  lines: PurchaseOrderLineWriteInput[];
}

export interface PurchaseOrderUpdateInput {
  supplierId: number;
  orderDate: string;
  expectedReceiptDate?: string | null;
}

/** P/O 등록·헤더 수정. 화면은 `W-01-11` 이 소유한다. 조회 셋은 `PurchaseOrderQueryService` 다. */
@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly query: PurchaseOrderQueryService,
  ) {}

  async create(
    input: PurchaseOrderCreateInput,
    appUserId: number,
  ): Promise<{ detail: PurchaseOrderDetail; versionNo: number }> {
    // 계약이 「최소 1행」이라 적었으나 `minItems` 를 걸지 않아 가드가 빈 배열을 통과시킨다
    // (입고 선례 `goods-receipt.service.ts:120`).
    if (input.lines.length === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('lines', ERROR_CODE.LINE_REQUIRED, 'P/O 라인이 1건 이상이어야 합니다.'),
      ]);
    }

    // ⛔ 채번은 `$transaction` 을 «열기 전»에 부른다 — 열린 트랜잭션 안에서 부르면 이
    //    요청이 커넥션을 둘 쥐고, 동시 요청이 풀을 채우면 P2024 로 죽는다(I-2.md R-2).
    // ⛔ 재시도 루프(입고 `NUMBER_RETRY`)를 두지 않는다 — 카운터가 `INSERT … ON
    //    CONFLICT … RETURNING` 한 문장이라 동시 등록도 값이 안 겹친다. 남는 위험은
    //    채번 밖의 «기존 행»뿐이다(이관·수기로 미리 심긴 purchase_order_no) — 그때는
    //    재시도 없이 P2002 가 그대로 400 `UNIQUE_VIOLATION`(field=purchaseOrderNo) 으로
    //    나간다(공용 `prismaErrorResponse`).
    const purchaseOrderNo = await this.numbering.next(
      'PURCHASE_ORDER',
      BigInt(input.plantId),
      input.orderDate,
    );

    const purchaseOrderId = await this.prisma.$transaction(async (tx) => {
      // ⚠ businessUnitId × plantId 의 법인 정합은 보지 않는다(입고의 warehouse.plant_id
      //   검사와 다른 자리 — 두 FK 가 각자 다른 legal_entity 에 달려도 그대로 저장된다.
      //   이 PR 은 원장을 지나지 않아 파급이 작지만 다음 전달분 「알려둘 것」감이다).
      const created = await tx.purchase_order.create({
        data: {
          purchase_order_no: purchaseOrderNo,
          supplier_id: input.supplierId,
          business_unit_id: input.businessUnitId,
          plant_id: input.plantId,
          order_date: new Date(input.orderDate),
          status_code: 'REGISTERED',
          created_by: BigInt(appUserId),
          source_inbound_receipt_line_id: input.sourceInboundReceiptLineId ?? null,
          ...optionalDate('expected_receipt_date', input.expectedReceiptDate),
        },
      });
      // 본문의 purchaseOrderLineId 는 무시한다 — 등록은 언제나 신규 행이다(R-8 ⓑ).
      // lineNo 는 배열 순서로 서버가 부여한다(계약 · uq_purchase_order_line).
      // ⚠ 라인 FK 위반은 최상위 `uomId`/`itemId` 를 짚는다(`lines[i].*` 가 아니다) —
      //   입고 선례(등록 전 라인별 조회)와 달리 이 PR 은 그 조회를 하지 않는다.
      await tx.purchase_order_line.createMany({
        data: input.lines.map((line, index) => ({
          purchase_order_id: created.purchase_order_id,
          line_no: index + 1,
          item_id: line.itemId,
          ordered_qty: line.orderedQty,
          uom_id: line.uomId,
          tolerance_over_qty: line.toleranceOverQty ?? 0,
          tolerance_under_qty: line.toleranceUnderQty ?? 0,
        })),
      });
      return created.purchase_order_id;
    });

    return this.query.get(Number(purchaseOrderId));
  }

  /**
   * 「작성중 상태에서만 허용한다」(계약). 값 목록에 「작성중」이 없어 `REGISTERED` 하나로
   * 푼다 — P/O 는 1차 내내 그 값에 머물러 이 가드는 e2e 로 못 세우고 단위 테스트로만
   * 세운다(I-2.md §7-4). 본문 밖 칸(사업부·공장·상태·ERP 번호)은 스키마에 없어 손대지
   * 않는다.
   */
  async update(
    purchaseOrderId: number,
    version: number,
    input: PurchaseOrderUpdateInput,
    appUserId: number,
  ): Promise<{ purchaseOrder: PurchaseOrderView; versionNo: number }> {
    const current = await this.prisma.purchase_order.findUnique({
      where: { purchase_order_id: purchaseOrderId },
    });
    if (!current) throw new NotFoundException('없는 P/O 입니다.');
    if (current.status_code !== 'REGISTERED') {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('statusCode', ERROR_CODE.STATE_LOCKED, '작성중 상태에서만 수정할 수 있습니다.'),
      ]);
    }

    const updated = await this.prisma.purchase_order.updateMany({
      where: { purchase_order_id: purchaseOrderId, version_no: version },
      data: {
        supplier_id: input.supplierId,
        order_date: new Date(input.orderDate),
        // 전체 치환이라 생략 = 비움이다(선례 notice.service.ts:203 `?? null` 과 같은 판정) —
        // create 의 `optionalDate` 호출과 모양을 맞춘다.
        ...optionalDate('expected_receipt_date', input.expectedReceiptDate ?? null),
        updated_by: BigInt(appUserId),
        version_no: { increment: 1 },
      },
    });
    // 존재는 위에서 이미 확인했다 — 0행이면 그 사이 값이 바뀐 것이다(재로드로 풀린다).
    assertUpdated(updated.count);

    const row = await this.prisma.purchase_order.findUniqueOrThrow({
      where: { purchase_order_id: purchaseOrderId },
    });
    return { purchaseOrder: purchaseOrderView(row), versionNo: row.version_no };
  }
}

function field(name: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field: name, code, message };
}
