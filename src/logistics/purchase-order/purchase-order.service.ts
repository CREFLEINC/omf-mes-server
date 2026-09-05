import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { optionalDate } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { ApprovalService } from '../../core/approval';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseOrderQueryService } from './purchase-order-query.service';
import {
  PurchaseOrderDetail,
  PurchaseOrderLineView,
  PurchaseOrderView,
  purchaseOrderView,
} from './purchase-order-view';

/**
 * 승인 유형과 대상 유형이 둘 다 `PURCHASE_ORDER` 다 — 우연히 같은 문자열이지 같은 축이
 * 아니다(유형은 `CD-APPROVAL-TYPE` 9값 중 하나, 대상은 `app.entity_type_registry` 시드).
 * 본문이 둘 다 받지 않으므로 서버가 채운다(계약 · I-2.md §1-4).
 */
const APPROVAL_TYPE_CODE = 'PURCHASE_ORDER';
const TARGET_TYPE_CODE = 'PURCHASE_ORDER';

/**
 * 치환에서 살아 남는 라인의 `line_no` 를 잠시 밀어 두는 폭. 1↔2 맞바꾸기가
 * `uq_purchase_order_line` 을 «중간 상태»에서 깨므로, 한 문장으로 같은 폭만큼 밀어 두고
 * (그 사이에도 서로 유일하다) 최종 1..N 을 다시 준다. `CHECK (line_no > 0)` 이라 음수로는
 * 못 민다.
 */
const LINE_NO_SHIFT = 1_000_000;

export interface PurchaseOrderLineWriteInput {
  /** 치환에서는 갱신 대상을 짚는다. ⛔ 등록에서는 «무시한다» — 등록은 언제나 신규 라인이다
   *  (계약이 허용한 칸이라 400 으로 막지 않는다. I-2.md R-8 ⓑ). */
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

/** P/O 쓰기 넷(등록·헤더 수정·라인 치환·상신). 화면은 `W-01-11` 이 소유한다.
 *  조회 셋은 `PurchaseOrderQueryService` 다. */
@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly query: PurchaseOrderQueryService,
    private readonly approval: ApprovalService,
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

  /**
   * ⛔ 잠그는 단위가 «부모»다 — If-Match 도 응답 ETag 도 `purchase_order.version_no` 이고
   *   계약이 그 헤더를 직접 선언했다(§1-3 · 선례 `approval-route.service.ts replaceSteps`).
   *   라인의 `version_no` 는 손대지 않는다.
   * ⛔ 읽고 쓰는 것이 한 `$transaction` 이어야 한다 — 1↔2 맞바꾸기가 중간 상태에서
   *   `uq_purchase_order_line` 을 깬다.
   */
  async replaceLines(
    purchaseOrderId: number,
    version: number,
    items: PurchaseOrderLineWriteInput[],
    appUserId: number,
  ): Promise<{ items: PurchaseOrderLineView[]; versionNo: number }> {
    // 계약이 `minItems` 를 안 걸었다. 등록이 「최소 1행」이라 적힌 자리와 같은 자원이므로
    // 치환도 0행을 막는다 — 거부는 나중에 풀 수 있고 허용을 거부로 바꾸는 것은 깨는 변경이다.
    if (items.length === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('items', ERROR_CODE.LINE_REQUIRED, 'P/O 라인이 1건 이상이어야 합니다.'),
      ]);
    }

    const lines = await this.prisma.$transaction(async (tx) => {
      const current = await tx.purchase_order.findUnique({
        where: { purchase_order_id: purchaseOrderId },
        select: { status_code: true },
      });
      if (!current) throw new NotFoundException('없는 P/O 입니다.');
      if (current.status_code !== 'REGISTERED') {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field('statusCode', ERROR_CODE.STATE_LOCKED, '작성중 상태에서만 라인을 고칠 수 있습니다.'),
        ]);
      }
      const bumped = await tx.purchase_order.updateMany({
        where: { purchase_order_id: purchaseOrderId, version_no: version },
        data: { version_no: { increment: 1 }, updated_by: BigInt(appUserId) },
      });
      assertUpdated(bumped.count);

      const existing = await tx.purchase_order_line.findMany({
        where: { purchase_order_id: purchaseOrderId },
        select: { purchase_order_line_id: true, received_qty: true },
      });
      const known = new Map(existing.map((row) => [Number(row.purchase_order_line_id), row]));
      this.assertLinesFit(items, known);

      const removed = existing
        .map((row) => Number(row.purchase_order_line_id))
        .filter((lineId) => !items.some((item) => item.purchaseOrderLineId === lineId));
      if (removed.length > 0) {
        await this.assertNoSuccessor(tx, removed);
        await tx.purchase_order_line.deleteMany({
          where: { purchase_order_line_id: { in: removed.map((lineId) => BigInt(lineId)) } },
        });
      }
      await tx.$executeRaw`
        UPDATE logistics.purchase_order_line
           SET line_no = line_no + ${LINE_NO_SHIFT}
         WHERE purchase_order_id = ${BigInt(purchaseOrderId)}`;

      // ⚠ 라인 FK 위반은 최상위 `uomId`/`itemId` 를 짚는다(`items[i].*` 가 아니다) — 등록과
      //   같은 자리다(#193 리뷰 Minor-1 · 공용 `prismaErrorResponse` 가 제약 이름만 본다).
      for (const [index, item] of items.entries()) {
        // ⛔ `received_qty` 는 담지 않는다 — 누적 입하는 I-3 이 갱신하는 서버 값이다.
        const values = {
          line_no: index + 1,
          item_id: BigInt(item.itemId),
          ordered_qty: item.orderedQty,
          uom_id: BigInt(item.uomId),
          tolerance_over_qty: item.toleranceOverQty ?? 0,
          tolerance_under_qty: item.toleranceUnderQty ?? 0,
        };
        if (item.purchaseOrderLineId === undefined) {
          await tx.purchase_order_line.create({
            data: { purchase_order_id: purchaseOrderId, created_by: BigInt(appUserId), ...values },
          });
        } else {
          await tx.purchase_order_line.update({
            where: { purchase_order_line_id: item.purchaseOrderLineId },
            data: { ...values, updated_by: BigInt(appUserId) },
          });
        }
      }
      return this.query.lines(purchaseOrderId, tx);
    });

    return { items: lines, versionNo: version + 1 };
  }

  /**
   * ⛔ 상태를 «안 옮긴다» — 옮길 값이 목록에 없고 승인 진행은 `approval_request.status_code`
   *   가 진다(I-2.md §5-3).
   * ⛔ `version_no` 를 «올리지 않는다» — 202 에 ETag 가 없어 화면이 새 토큰을 받을 길이
   *   없고, 올리면 다음 `PUT` 이 상세 GET 을 다시 돌 때까지 영원히 409 다(§6-3).
   * ⛔ 그래도 «읽고 비교는 한다» — 안 그러면 계약이 선언한 409 가 도달 불가능한 응답이
   *   된다(가드는 헤더의 존재만 본다).
   * ⛔ 버전을 안 올리니 낙관적 잠금이 동시 상신을 못 가른다 — 트랜잭션 첫 문장에서 대상
   *   행을 `FOR UPDATE` 로 잠그고 «그 바로 뒤»가 비교 자리다(R-4).
   */
  async requestApproval(
    purchaseOrderId: number,
    version: number,
    reason: string,
    appUserId: number,
  ): Promise<{ approvalRequestId: number }> {
    const exists = await this.prisma.purchase_order.findUnique({
      where: { purchase_order_id: purchaseOrderId },
      select: { purchase_order_id: true },
    });
    if (!exists) throw new NotFoundException('없는 P/O 입니다.');

    // ⛔ 채번은 `$transaction` 을 «열기 전»에 부른다(R-2). `approval_request` 에 공장 축이
    //    없어 공장 지정 규칙을 찾지 않는다 — 픽스처와 같은 규칙을 탄다(§3-6).
    // ⚠ 기간키가 UTC 라 하노이(UTC+7) 00:00–07:00 의 상신은 «전날» 번호를 받는다. 이 표는
    //   `business_date` 를 안 실어 C-8 자리가 아니고 선례(`approval-request.fixture.ts`)와
    //   같은 형태다 — AP 번호의 날짜를 현지 영업일로 읽지 말 것.
    const approvalRequestNo = await this.numbering.next(
      'APPROVAL_REQUEST',
      null,
      new Date().toISOString().slice(0, 10),
    );

    const approvalRequestId = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ version_no: number; business_unit_id: bigint }[]>`
        SELECT version_no, business_unit_id
          FROM logistics.purchase_order
         WHERE purchase_order_id = ${BigInt(purchaseOrderId)}
           FOR UPDATE`;
      if (!locked) throw new NotFoundException('없는 P/O 입니다.');
      if (locked.version_no !== version) assertUpdated(0);

      const created = await this.approval.request(tx, {
        approvalRequestNo,
        approvalTypeCode: APPROVAL_TYPE_CODE,
        targetTypeCode: TARGET_TYPE_CODE,
        targetId: BigInt(purchaseOrderId),
        // ⚠ 9 상신자 중 P/O 만 전표 값을 준다(나머지 여덟은 공통본 `null`) — 문의 022.
        businessUnitId: locked.business_unit_id,
        requestedBy: BigInt(appUserId),
        reason,
      });
      // ⛔ `WHERE version_no = ?` 를 걸지 않는다 — 위에서 잠그고 비교했고 버전을 올리지도
      //    않으므로 조건부 UPDATE 가 쓸 자리가 아니다.
      await tx.purchase_order.update({
        where: { purchase_order_id: purchaseOrderId },
        data: { approval_request_id: created.approvalRequestId },
      });
      return created.approvalRequestId;
    });

    return { approvalRequestId: Number(approvalRequestId) };
  }

  /**
   * ⛔ `ck_po_line_received CHECK (received_qty <= ordered_qty + tolerance_over_qty)` 를
   * 손으로 먼저 본다 — CHECK 위반은 `PrismaClientUnknownRequestError` 라 공용 그물에 안
   * 걸리고 500 으로 샌다(I-2.md §2-2 · 입고에서 이미 한 번 고친 자리).
   * 함께 — 짚는 행이 «없거나»(다른 P/O 의 라인) «둘 이상 겹치면» 조용한 사고가 된다.
   * 겹치면 같은 행에 `update` 가 두 번 걸려 요청 N건이 응답 N-1건으로 줄고도 200 이다 —
   * 유일 제약도 CHECK 도 안 걸려 DB 가 못 잡는다(#194 리뷰 Major-1).
   */
  private assertLinesFit(
    items: PurchaseOrderLineWriteInput[],
    known: Map<number, { received_qty: Prisma.Decimal }>,
  ): void {
    const seen = new Set<number>();
    for (const [index, item] of items.entries()) {
      const lineId = item.purchaseOrderLineId;
      if (lineId === undefined) continue;
      const row = known.get(lineId);
      if (!row) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field(`items.${index}.purchaseOrderLineId`, ERROR_CODE.INVALID, '이 P/O 의 라인이 아닙니다.'),
        ]);
      }
      if (seen.has(lineId)) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field(`items.${index}.purchaseOrderLineId`, ERROR_CODE.INVALID, '같은 라인을 두 번 실었습니다.'),
        ]);
      }
      seen.add(lineId);
      if (item.orderedQty + (item.toleranceOverQty ?? 0) < Number(row.received_qty)) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field(
            `items.${index}.orderedQty`,
            ERROR_CODE.RANGE,
            '이미 받은 수량보다 적게 발주할 수 없습니다.',
          ),
        ]);
      }
    }
  }

  /**
   * 「이미 입하가 붙은 라인은 지울 수 없다」(계약). 판정은 «행 존재»다 — `received_qty > 0`
   * 이 아니다(0 인 입하 라인도 붙은 것이다). ⛔ `asn_line` 도 함께 본다 — 그 FK 가 실재해
   * ASN 만 붙은 라인을 지우면 FK 위반이 500 으로 샌다(I-2.md R-6).
   */
  private async assertNoSuccessor(tx: Prisma.TransactionClient, lineIds: number[]): Promise<void> {
    const where = { purchase_order_line_id: { in: lineIds.map((lineId) => BigInt(lineId)) } };
    const successors =
      (await tx.inbound_receipt_line.count({ where })) + (await tx.asn_line.count({ where }));
    if (successors > 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.SUCCESSOR_EXISTS,
          message: '이미 입하가 붙은 라인은 지울 수 없습니다.',
        },
      ]);
    }
  }
}

function field(name: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field: name, code, message };
}
