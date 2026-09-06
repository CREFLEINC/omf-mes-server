import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { omitEmpty } from '../../common/http/omit-empty';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { CancelEligibilityService } from './cancel-eligibility.service';
import { cancelInboundReceipt } from './adapters/inbound-receipt-cancel.adapter';
import { CancelableDocumentType, DocumentCancelService } from './document-cancel.service';
import { DOCUMENT_SCHEMA, DOCUMENT_TYPES } from './document-type-registry';

/** 계약 `CancelResult`. 뒤 두 칸은 `reversed:false` 면 «키를 생략»한다(plan.md §5 규칙 7). */
export interface CancelResult {
  documentTypeCode: CancelableDocumentType;
  documentId: number;
  statusCode: string;
  reversed: boolean;
  reversalTransactionNo?: string;
  reversalBusinessDate?: string;
}

/** 코어 `reverse()` 가 낸 역트랜잭션 — 응답의 선택 2칸이 여기서 온다. */
interface LedgerReversal {
  transactionNo: string;
  businessDate: string;
}

const CANCEL = 'document-cancel';
const CANCELLED = 'CANCELLED';

/** 화면이 안내 문구와 다음 경로를 이 코드로 가른다 — 조회의 사유 코드와 «같은 문자열»이다. */
export const screenError = (code: string, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code, message }]);

/**
 * 물류 문서 취소 «실행»(PR ⑤). 잠금·상태 쓰기 두 문장은 요청 서비스에서 빌린다(같은 모듈).
 * ⛔ 입하·입고·출고 «도메인» service 는 주입하지 않는다 — 원장은 코어 `reverse()` 하나로만 건드린다.
 */
@Injectable()
export class DocumentCancelExecuteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: DocumentCancelService,
    private readonly approvals: ApprovalService,
    private readonly documentState: DocumentStateService,
    private readonly eligibility: CancelEligibilityService,
    private readonly posting: InventoryPostingService,
  ) {}

  /** 취소 실행. ⛔ 채번을 안 부른다 — 역행 번호는 `{원 번호}-R` 파생이다(§3-5). */
  async cancel(
    typeCode: CancelableDocumentType,
    documentId: bigint,
    version: number,
    appUserId: number,
  ): Promise<CancelResult> {
    // 역처리가 «언제» 일어났는지만 새 사실이다 — 영업일은 원 원장의 것이다(§3-4).
    const occurredAt = new Date();

    const done = await this.prisma.$transaction(async (tx) => {
      const locked = await this.requests.lockDocument(tx, typeCode, documentId);
      if (locked === undefined) throw new NotFoundException('없는 문서입니다.');
      // 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 풀린다).
      if (locked.version_no !== version) assertUpdated(0);
      const previous = locked.status_code;

      // ⭐ 상태 자물쇠보다 «앞»이다 — 두 번째 `:cancel` 에는 조회 사유 순위 2 와 같은 문자열이 맞다.
      if (previous === CANCELLED) {
        throw screenError(ERROR_CODE.ALREADY_CANCELLED, '이미 취소된 문서입니다.');
      }
      // ⭐ 「승인이 끝난 요청만 받는다」의 정본 가드는 이 상태 자물쇠다 — `assertApproved` 는
      //    요청이 0건이면 «통과»한다(실측). `CANCEL_REQUESTED` 는 `:request-cancel` 만 만든다(R-8).
      const mapping = DOCUMENT_TYPES[typeCode];
      const transition = this.documentState.assertTransition(
        `${DOCUMENT_SCHEMA}.${mapping.delegate}.status_code`,
        CANCEL,
        previous,
        HttpStatus.BAD_REQUEST,
      );

      // 승인 판정이 후속 재판정 «앞»이다 — 승인 없이 부른 호출에 후속 사유를 알려 주지 않는다(§6-3).
      await this.approvals.assertApproved(tx, typeCode, documentId, `${typeCode}_CANCEL`);

      // ⭐ J-8 재판정 — 승인 대기 중에 후속이 생겼을 수 있다. ⛔ `cancellable` 이 아니라
      //    `successorCount` 다: 나머지 사유 넷은 「지금 승인된 이 요청」자신을 가리킨다(§6-3).
      const { successorCount } = await this.eligibility.evaluate(tx, typeCode, documentId);
      if (successorCount > 0) {
        // 걸리면 흔적을 «아무것도» 안 남긴다 — 승인도 문서 상태도 그대로다(계약 J-8).
        throw screenError(ERROR_CODE.SUCCESSOR_EXISTS, '후속 문서가 있어 취소할 수 없습니다.');
      }

      await this.writeCancellation(tx, typeCode, documentId, previous, appUserId, occurredAt);

      // ⭐ 유형별 갈림(§6-4) — 상태 전이 «앞»이다: 역처리가 400 `NEGATIVE_BALANCE` 면 상태도 안
      //    옮긴다. 입하는 전기 경로가 없어(plan-api.md S02) 원장을 안 보고 발주 수취 누계만
      //    되돌린다 ⇒ `reversed` 언제나 거짓. 입고·출고는 원장«만» 되돌린다 — ⛔ `putaway_task`
      //    (계약 후속 5값에 없다 · ⚠ 취소된 입고의 적치 지시가 남는다) · ⛔ `goods_issue` 의 취소
      //    3칸(흔적 정본은 `document_cancellation` 한 표 · §2-4) · ⛔ `approval_request_id`
      //    (I-4 의 폐기 품의 · §2-5) 를 안 건드린다.
      let reversal: LedgerReversal | undefined;
      if (typeCode === 'INBOUND_RECEIPT') {
        await cancelInboundReceipt(tx, documentId);
      } else {
        reversal = await this.reverseLedger(tx, typeCode, documentId, occurredAt, appUserId);
      }

      await this.requests.applyStatus(tx, mapping, documentId, version, transition.to);
      return { statusCode: transition.to, reversal };
    });

    return omitEmpty({
      documentTypeCode: typeCode,
      documentId: Number(documentId),
      statusCode: done.statusCode,
      reversed: done.reversal !== undefined,
      reversalTransactionNo: done.reversal?.transactionNo,
      reversalBusinessDate: done.reversal?.businessDate,
    });
  }

  /**
   * 원 원장을 찾아 되돌린다. 0행이면 `undefined` — 전기 전이었다는 뜻이다.
   * ⭐ **I-5.md §6-3 과 달리 한 곳** — ⌜`previous === 'POSTED'` 면 역처리⌝ 는 못 쓴다: `:cancel`
   *    은 «언제나» `CANCEL_REQUESTED` 를 봐서 영원히 거짓이다. §6-4 의 원장 0행/1행이 가른다.
   * ⛔ 역행 자신이 원 행의 `source_document_*` 를 물려받아 같은 조회에 걸리므로
   *    `reversal_of_transaction_id IS NULL` 로 뺀다. 이미 되돌려졌으면 코어가 알려 준다(R-3).
   */
  private async reverseLedger(
    tx: Prisma.TransactionClient,
    typeCode: CancelableDocumentType,
    documentId: bigint,
    occurredAt: Date,
    appUserId: number,
  ): Promise<LedgerReversal | undefined> {
    const rows = await tx.inventory_transaction.findMany({
      where: {
        source_document_type_code: typeCode,
        source_document_id: documentId,
        reversal_of_transaction_id: null,
      },
      select: { inventory_transaction_id: true, business_date: true },
    });
    if (rows.length === 0) return undefined;
    // 한 문서는 원장 하나다 — 조용히 첫 행을 고르지 않는다. 클라이언트가 고칠 것이 아니라 500 이다.
    if (rows.length > 1) {
      throw new Error(`한 문서에 원장이 ${rows.length} 행이다: ${typeCode}/${documentId}`);
    }
    const reversed = await this.posting.reverse(tx, {
      inventoryTransactionId: rows[0].inventory_transaction_id,
      // ⛔ 원 트랜잭션의 영업일이다 — `:cancel` 이 `businessDate` 를 안 받는다(계약 · C-8).
      businessDate: rows[0].business_date.toISOString().slice(0, 10),
      occurredAt,
      createdBy: appUserId,
    });
    return { transactionNo: reversed.transactionNo, businessDate: reversed.businessDate };
  }

  /**
   * 취소 흔적은 `app.document_cancellation` «한 표»가 진다(§2-4). 사유 원문은 취소 승인 요청의
   * `reason` 이고 다형 축으로 읽는다 — 대상 표의 FK 는 업무 승인만 진다(§2-5).
   * ⛔ `reason_code` 를 안 채운다 — 계약이 사유 «코드»를 안 보내고 그 코드 그룹이 없다(마이그 · R-1).
   * ⚠ `previous_status_code` 는 «언제나» `CANCEL_REQUESTED` 다 — 요청이 상태를 먼저 옮긴다.
   */
  private async writeCancellation(
    tx: Prisma.TransactionClient,
    typeCode: CancelableDocumentType,
    documentId: bigint,
    previousStatusCode: string,
    appUserId: number,
    cancelledAt: Date,
  ): Promise<void> {
    const approved = await tx.approval_request.findFirst({
      where: {
        target_type_code: typeCode,
        target_id: documentId,
        approval_type_code: `${typeCode}_CANCEL`,
        status_code: 'APPROVED',
      },
      orderBy: { approval_request_id: 'desc' },
      select: { reason: true },
    });
    await tx.document_cancellation.create({
      data: {
        document_type_code: typeCode,
        document_id: documentId,
        previous_status_code: previousStatusCode,
        ...(approved === null ? {} : { reason_detail: approved.reason }),
        cancelled_at: cancelledAt,
        cancelled_by: BigInt(appUserId),
      },
    });
  }
}
