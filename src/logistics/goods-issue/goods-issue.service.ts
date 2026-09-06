import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODE, ErrorItem, field, ContractException } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsIssueView, goodsIssueView } from './goods-issue-view';
import { postIssue } from './issue-posting';

/** 계약 `PostRequest` — required 2. 서버가 도출하지 않는다(C-8 · C-1). */
export interface PostIssueRequest {
  businessDate: string;
  occurredAt: string;
}

const STATUS_COLUMN = 'logistics.goods_issue.status_code';
const POST_ACTION = 'document-post';
/** 계약이 언제나 이 유형이라 못박았다 — 본문이 승인 유형을 받지 않는다(계약 `:request-approval`). */
const APPROVAL_TYPE = 'GOODS_ISSUE_DISPOSAL';
const TARGET_TYPE = 'GOODS_ISSUE';
/** 잔액 선잠금이 커밋까지 간다 — 기본 5초를 넘기면 `P2028` 이 500 으로 샌다(I-3.md R-4). */
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/** 출고 쓰기. 조회 3건은 `GoodsIssueQueryService`, 등록·치환·상신은 PR ④⑤ 가 얹는다. */
@Injectable()
export class GoodsIssueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly approvals: ApprovalService,
    private readonly documentState: DocumentStateService,
  ) {}

  /**
   * ⭐ 순서가 불변식이다 — 헤더 `FOR UPDATE` → 승인 게이트 → LOT 차단 → 잔액 잠금 →
   * 손검사 → 원장 → 되짚기 → 상태 전이. 「헤더 → 잔액」 한 방향이면 라인 치환(PR ⑤)과
   * 전기가 같은 자물쇠에서 직렬화된다(I-4.md §3-4).
   *
   * ⛔ 채번을 안 부른다 — 번호는 등록에서 이미 났다.
   * ⛔ 응답에 ETag 를 안 내린다 — 계약이 `:post` 200 에 헤더를 선언하지 않았다(§6-3).
   *    `version_no` 는 올린다(상태를 옮기므로) — 다음 If-Match 는 상세 GET 이 준다.
   */
  async post(
    goodsIssueId: number,
    version: number,
    input: PostIssueRequest,
    appUserId: number,
  ): Promise<GoodsIssueView> {
    assertPostRequest(input);

    return this.prisma.$transaction(async (tx) => {
      // ⛔ 헤더를 먼저 «잠근다» — findUnique 로 읽으면 같은 순간의 두 `:post` 가 둘 다
      //    `REGISTERED` 를 보고 잔액을 두 번 깎는다(상태 잠금이 ③번째 겹이다 · §3-8).
      const [header] = await tx.$queryRaw<HeaderRow[]>`
        SELECT goods_issue_id, goods_issue_no, source_warehouse_id, destination_type_code,
               destination_id, status_code, version_no
          FROM logistics.goods_issue
         WHERE goods_issue_id = ${goodsIssueId}
           FOR UPDATE`;
      if (header === undefined) throw new NotFoundException('없는 출고 전표입니다.');
      if (header.version_no !== version) {
        // 존재는 위에서 확인했다 — 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 풀린다).
        assertUpdated(0);
      }
      // ⛔ `conflictStatus` 는 400 이다 — 계약이 같은 축에 「400 `STATE_LOCKED`」를 적었고
      //    409 는 If-Match 저장 충돌 전용이다(`approval.service.ts:263`). 재전기가 여기 걸린다.
      this.documentState.assertTransition(
        STATUS_COLUMN,
        POST_ACTION,
        header.status_code,
        HttpStatus.BAD_REQUEST,
      );
      // 어느 전표가 이 자물쇠를 타는지는 호출자가 정한다 — `:post` 는 언제나 부른다(I-4.md §4-2 · 문의 030)
      await this.approvals.assertApproved(
        tx,
        TARGET_TYPE,
        header.goods_issue_id,
        APPROVAL_TYPE,
      );

      const lines = await tx.goods_issue_line.findMany({
        where: { goods_issue_id: header.goods_issue_id },
        orderBy: { line_no: 'asc' },
        select: {
          goods_issue_line_id: true,
          item_id: true,
          lot_id: true,
          issue_qty: true,
          uom_id: true,
          source_location_id: true,
        },
      });
      // 라인 0건은 잠금·손검사 0건으로 지나 빈 원장을 세운다 — 등록·치환이 막지만 여기서도 막는다.
      if (lines.length === 0) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field('lines', ERROR_CODE.LINE_REQUIRED, '출고 라인이 1건 이상이어야 합니다.'),
        ]);
      }
      await postIssue(
        tx,
        this.posting,
        {
          header: {
            goodsIssueId: header.goods_issue_id,
            goodsIssueNo: header.goods_issue_no,
            sourceWarehouseId: header.source_warehouse_id,
            destinationTypeCode: header.destination_type_code,
            destinationId: header.destination_id,
          },
          lines: lines.map((line) => ({
            goodsIssueLineId: line.goods_issue_line_id,
            itemId: line.item_id,
            lotId: line.lot_id,
            issueQty: line.issue_qty,
            uomId: line.uom_id,
            sourceLocationId: line.source_location_id,
          })),
          businessDate: input.businessDate,
          occurredAt: new Date(input.occurredAt),
        },
        appUserId,
      );

      const moved = await tx.goods_issue.updateMany({
        where: { goods_issue_id: header.goods_issue_id, version_no: version },
        data: { status_code: 'POSTED', version_no: { increment: 1 }, updated_by: BigInt(appUserId) },
      });
      assertUpdated(moved.count);
      // ⭐ 200 은 상세가 아니라 **헤더 하나**다(계약 응답 스키마 `GoodsIssue`).
      const row = await tx.goods_issue.findUniqueOrThrow({
        where: { goods_issue_id: header.goods_issue_id },
      });
      return goodsIssueView(row);
    }, TRANSACTION_OPTIONS);
  }
}

interface HeaderRow {
  goods_issue_id: bigint;
  goods_issue_no: string;
  source_warehouse_id: bigint;
  destination_type_code: string | null;
  destination_id: bigint | null;
  status_code: string;
  version_no: number;
}

/** 형식 검증은 트랜잭션 «밖»이다 — 입고 `goods-receipt.service.ts:156-161` 선례. */
function assertPostRequest(input: PostIssueRequest): void {
  const errors: ErrorItem[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) || Number.isNaN(Date.parse(input.businessDate))) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식입니다.'));
  }
  if (Number.isNaN(Date.parse(input.occurredAt))) {
    errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
