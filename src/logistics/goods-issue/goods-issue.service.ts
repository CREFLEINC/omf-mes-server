import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  ErrorItem,
  field,
} from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsIssueCreate, REGISTERED, assertCreatable } from './goods-issue-rules';
import {
  GoodsIssueDetail,
  GoodsIssueView,
  goodsIssueLineView,
  goodsIssueView,
} from './goods-issue-view';
import { GoodsIssueLineWriteInput, postIssue } from './issue-posting';

/** 계약 `PostRequest` — required 2. 서버가 도출하지 않는다(C-8 · C-1). */
export interface PostIssueRequest {
  businessDate: string;
  occurredAt: string;
}

const STATUS_COLUMN = 'logistics.goods_issue.status_code';
const POST_ACTION = 'document-post';
const POSTED = 'POSTED';
/** 채번이 부딪히는 것은 사용자가 고칠 수 없는 값이라 다시 뽑는다(입고 선례). */
const NUMBER_RETRY = 3;
/** 계약이 언제나 이 유형이라 못박았다 — 본문이 승인 유형을 받지 않는다(계약 `:request-approval`).
 *  ⛔ 상신(`GoodsIssueUpdateService`)과 «같은 값»이어야 한다 — 갈리면 상신한 전표를 `:post` 의
 *  게이트가 못 찾아 승인 없이 나간다. 그래서 여기서 export 하고 한 벌만 둔다. */
export const APPROVAL_TYPE = 'GOODS_ISSUE_DISPOSAL';
export const TARGET_TYPE = 'GOODS_ISSUE';
/** 잔액 선잠금이 커밋까지 간다 — 기본 5초를 넘기면 `P2028` 이 500 으로 샌다(I-3.md R-4). */
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/** 출고 쓰기. 조회 3건은 `GoodsIssueQueryService`, 라인 치환·상신은 PR ⑤ 가 얹는다. */
@Injectable()
export class GoodsIssueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly approvals: ApprovalService,
    private readonly documentState: DocumentStateService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * 등록. ⭐ `postImmediately` 가 참이면 **등록과 전기가 같은 트랜잭션**이다 — 「두 번 호출로
   * 나누면 오프라인 큐에 중간 상태가 남는다」(계약 · §3-9). If-Match 는 안 받는다(§6-3).
   */
  async create(
    input: GoodsIssueCreate,
    appUserId: number,
  ): Promise<{ detail: GoodsIssueDetail; versionNo: number }> {
    const plantId = await assertCreatable(this.prisma, input);

    for (let attempt = 0; ; attempt += 1) {
      try {
        // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 열린 트랜잭션 안에서 부르면 한
        //    요청이 커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(입고 :103-107 · I-2.md R-2).
        // ⛔ 기간 축은 클라이언트가 준 `businessDate` 그대로다 — 서버가 「오늘」로 다시 잡지
        //    않는다(공유계약 C-8 · CLAUDE.md).
        const issueNo = await this.numbering.next('GOODS_ISSUE', plantId, input.businessDate);
        return await this.prisma.$transaction(
          (tx) => this.write(tx, input, issueNo, appUserId),
          TRANSACTION_OPTIONS,
        );
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '출고번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  /** 헤더 → 라인 → (참이면) 전기 → 되읽기. 한 트랜잭션이다. */
  private async write(
    tx: Prisma.TransactionClient,
    input: GoodsIssueCreate,
    issueNo: string,
    appUserId: number,
  ): Promise<{ detail: GoodsIssueDetail; versionNo: number }> {
    const issue = await tx.goods_issue.create({
      data: {
        goods_issue_no: issueNo,
        issue_type_code: input.issueTypeCode,
        source_document_type_code: input.sourceDocumentTypeCode,
        source_document_id: input.sourceDocumentId,
        source_warehouse_id: input.sourceWarehouseId,
        // 짝 그대로 담는다 — 자체 폐기면 둘 다 널이다(계약 · `ck_goods_issue_destination`).
        destination_type_code: input.destinationTypeCode ?? null,
        destination_id: input.destinationId ?? null,
        issued_at: new Date(input.issuedAt),
        status_code: REGISTERED,
        reason_code: input.reasonCode ?? null,
        replacement_expected: input.replacementExpected ?? null,
        remarks: input.remarks ?? null,
        created_by: BigInt(appUserId),
      },
    });
    // ⛔ `businessDate`·`occurredAt`·`sendToErp` 를 헤더에 «안 담는다» — 칸이 없다. 앞의 둘은
    //    `postImmediately` 가 거짓이면 저장할 표가 아예 없다(원장을 안 지난다 · I-4.md §2-5).

    const lines: GoodsIssueLineWriteInput[] = [];
    for (const [index, line] of input.lines.entries()) {
      const created = await tx.goods_issue_line.create({
        data: {
          goods_issue_id: issue.goods_issue_id,
          // ⛔ 본문의 `goodsIssueLineId` 는 무시한다 — 「서버가 부여하며 화면이 정하지
          //    않는다」(계약 `GoodsIssueLine.lineNo`). 요청 순서대로 1..N 이다.
          line_no: index + 1,
          picking_line_id: line.pickingLineId ?? null,
          item_id: line.itemId,
          lot_id: line.lotId,
          issue_qty: line.issueQty,
          uom_id: line.uomId,
          source_location_id: line.sourceLocationId,
          created_by: BigInt(appUserId),
        },
      });
      lines.push({
        goodsIssueLineId: created.goods_issue_line_id,
        pickingLineId: created.picking_line_id,
        itemId: created.item_id,
        lotId: created.lot_id,
        issueQty: created.issue_qty,
        uomId: created.uom_id,
        sourceLocationId: created.source_location_id,
      });
    }

    if (input.postImmediately === true) {
      await this.postOnCreate(tx, issue, lines, input, appUserId);
    }

    // 상세 매퍼는 PR ① 것을 그대로 쓴다 — 전기가 상태·되짚기를 바꿔 두므로 되읽는다.
    const row = await tx.goods_issue.findUniqueOrThrow({
      where: { goods_issue_id: issue.goods_issue_id },
    });
    const rows = await tx.goods_issue_line.findMany({
      where: { goods_issue_id: issue.goods_issue_id },
      orderBy: { line_no: 'asc' },
    });
    return {
      detail: { goodsIssue: goodsIssueView(row), lines: rows.map(goodsIssueLineView) },
      versionNo: row.version_no,
    };
  }

  /**
   * 등록과 «같은» 트랜잭션의 전기 — 전기 몸통은 `:post` 와 **같은 `postIssue()`** 를 탄다.
   * ⛔ `document-post` 전이를 부르지 않는다 — from 이 없는 전이라 표에 담을 수 없다(I-4.md §3-9).
   * ⛔ `version_no` 를 안 올린다 — «옮기는» 것이 아니라 처음부터 `POSTED` 로 «만든다»(ETag 는 1).
   */
  private async postOnCreate(
    tx: Prisma.TransactionClient,
    issue: { goods_issue_id: bigint; goods_issue_no: string },
    lines: GoodsIssueLineWriteInput[],
    input: GoodsIssueCreate,
    appUserId: number,
  ): Promise<void> {
    // 방금 만든 전표라 승인 요청이 있을 수 없다 — 게이트는 언제나 통과한다. 폐기 출고가 이
    // 값으로 오면 승인을 건너뛴다 — 계약이 막지 않았다(문의 030 갈래 ③).
    await this.approvals.assertApproved(tx, TARGET_TYPE, issue.goods_issue_id, APPROVAL_TYPE);
    await postIssue(
      tx,
      this.posting,
      {
        header: {
          goodsIssueId: issue.goods_issue_id,
          goodsIssueNo: issue.goods_issue_no,
          issueTypeCode: input.issueTypeCode,
          sourceDocumentTypeCode: input.sourceDocumentTypeCode,
          sourceDocumentId: BigInt(input.sourceDocumentId),
          sourceWarehouseId: BigInt(input.sourceWarehouseId),
          destinationTypeCode: input.destinationTypeCode ?? null,
          destinationId: input.destinationId == null ? null : BigInt(input.destinationId),
        },
        lines,
        // ⛔ 본문 값 그대로다 — 참일 때만 원장 키의 일부가 된다(§2-5 · C-8 · C-1).
        businessDate: input.businessDate,
        occurredAt: new Date(input.occurredAt),
      },
      appUserId,
    );
    await tx.goods_issue.update({
      where: { goods_issue_id: issue.goods_issue_id },
      data: { status_code: POSTED },
    });
  }

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
        SELECT goods_issue_id, goods_issue_no, issue_type_code, source_document_type_code,
               source_document_id, source_warehouse_id,
               destination_type_code, destination_id, status_code, version_no
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
          // ⭐ 되짚기용 선택 칸 — 소진 축은 헤더다(I-8.md R-4). 여기 싣는 것은 되짚기뿐이다.
          picking_line_id: true,
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
            issueTypeCode: header.issue_type_code,
            sourceDocumentTypeCode: header.source_document_type_code,
            sourceDocumentId: header.source_document_id,
            sourceWarehouseId: header.source_warehouse_id,
            destinationTypeCode: header.destination_type_code,
            destinationId: header.destination_id,
          },
          lines: lines.map((line) => ({
            goodsIssueLineId: line.goods_issue_line_id,
            pickingLineId: line.picking_line_id,
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
  issue_type_code: string;
  source_document_type_code: string;
  source_document_id: bigint;
  source_warehouse_id: bigint;
  destination_type_code: string | null;
  destination_id: bigint | null;
  status_code: string;
  version_no: number;
}

/** `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다(입고 선례). */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return (
    Array.isArray(target) &&
    target.some((column) => ['goods_issue_no', 'transaction_no'].includes(String(column)))
  );
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
