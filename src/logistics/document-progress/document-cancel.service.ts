import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { NumberingService } from '../../core/numbering';
import { ContractException } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { CancelEligibilityService } from './cancel-eligibility.service';
import { DOCUMENT_SCHEMA, DOCUMENT_TYPES, DocumentTypeMapping, LogisticsDocumentType } from './document-type-registry';

/** 취소 실행 축 3종 — 계약 경로 `documentTypeCode` enum(`CD-CANCELABLE-DOCUMENT-TYPE`). */
export type CancelableDocumentType = 'INBOUND_RECEIPT' | 'GOODS_RECEIPT' | 'GOODS_ISSUE';

const REQUEST_CANCEL = 'document-request-cancel';
const APPROVAL_DOCUMENT_TYPE = 'APPROVAL_REQUEST';

/** 유형별 `updateMany` 만 쓴다 — 칸 이름은 매핑이 준다(`idColumn`·`versionColumn`). */
interface WritableDelegate {
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

export interface LockedRow {
  status_code: string;
  version_no: number;
}

/**
 * 물류 문서 취소 «요청»(PR ④). 실행 `:cancel` 은 `document-cancel-execute.service.ts` 다
 * — 잠금·상태 쓰기 두 문장을 이 클래스가 내주고 둘이 같은 것을 쓴다.
 *
 * ⛔ 입하·입고·출고 도메인의 service 를 부르지 않는다 — `tx.<표>` 를 직접 쓴다. 코어
 *    (`ApprovalService`·`NumberingService`·`DocumentStateService`)만 주입한다.
 * ⛔ 대상 표의 `approval_request_id` 칸을 덮지 않는다 — I-4 의 업무 품의 흔적을 취소 품의가
 *    지우면 `:post` 의 자물쇠가 무너진다(I-5.md §2-5 · plan.md §5 #12). 정본은 다형 축이다.
 */
@Injectable()
export class DocumentCancelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
    private readonly numbering: NumberingService,
    private readonly documentState: DocumentStateService,
    private readonly eligibility: CancelEligibilityService,
  ) {}

  /**
   * 취소 요청 상신. 상태를 `CANCEL_REQUESTED` 로 옮기고 승인 요청을 만든다.
   *
   * ⚠ `version` 은 **대상 문서**의 `version_no` 다 — 이 경로의 응답이 아니라 대상 문서
   *   상세 GET(`/logistics/goods-receipts/{id}` 등)이 내려준 ETag 다(계약 · I-5.md §7-2).
   * ⛔ 응답에 ETag 를 안 내린다 — 계약이 202 에 헤더를 선언하지 않았다.
   */
  async requestCancel(
    typeCode: CancelableDocumentType,
    documentId: bigint,
    version: number,
    reason: string,
    appUserId: number,
  ): Promise<{ approvalRequestId: number }> {
    // ⛔ 채번은 `$transaction` 을 «열기 전»에 부른다 — 코어가 「롤백이 번호를 되돌리면 재시도가
    //    같은 번호를 뽑는다」로 못박았다(`numbering.service.ts` · I-2.md R-2).
    const approvalRequestNo = await this.numbering.next(
      APPROVAL_DOCUMENT_TYPE,
      null,
      new Date().toISOString().slice(0, 10),
    );

    const approvalRequestId = await this.prisma.$transaction(async (tx) => {
      // ⛔ 첫 문장에서 대상 행을 «잠근다» — `assertNoOpenRequest` 의 조회만으로는 같은 순간의
      //    두 상신이 둘 다 통과한다(`approval.service.ts` · I-2.md R-4).
      const locked = await this.lockDocument(tx, typeCode, documentId);
      if (locked === undefined) throw new NotFoundException('없는 문서입니다.');
      // 존재는 위에서 확인했다 — 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 풀린다).
      if (locked.version_no !== version) assertUpdated(0);

      // 조회 2건이 미리 보여 준 것과 «같은 함수»다 — 화면 안내와 실행 결과가 갈리지 않는다(§4-1).
      const verdict = await this.eligibility.evaluate(tx, typeCode, documentId);
      if (!verdict.cancellable) {
        // ⛔ 전건 400 이다 — 409 는 If-Match 저장 충돌 전용이고 `CANCEL_IN_PROGRESS` 도
        //    여기서는 400 이다(계약이 400 설명에 넷을 나란히 적었다 · I-5.md R-9).
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'screen',
            code: verdict.cancelBlockedReasonCode as string,
            message: '지금은 취소를 요청할 수 없습니다.',
          },
        ]);
      }

      const created = await this.approvals.request(tx, {
        approvalRequestNo,
        // 계약 `approvalTypeCode` enum 9값에 세 유형의 `_CANCEL` 이 있다(실측 · §6-2).
        approvalTypeCode: `${typeCode}_CANCEL`,
        // 다형 축은 문서 유형 그대로다 — `targetTypeCode` enum 8값과 글자가 같다.
        targetTypeCode: typeCode,
        targetId: documentId,
        // ⚠ 취소 3유형에 사업부를 파생할 축이 없다(입하·입고에 칸 자체가 없다) — 공통본(문의 022).
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason,
      });

      await this.moveToRequested(tx, typeCode, documentId, version, locked.status_code);
      return created.approvalRequestId;
    });

    return { approvalRequestId: Number(approvalRequestId) };
  }

  /** 전이 판정 → 조건부 UPDATE. 어긋나면 409 다(그 사이 누가 상태를 옮겼다). */
  private async moveToRequested(
    tx: Prisma.TransactionClient,
    typeCode: CancelableDocumentType,
    documentId: bigint,
    version: number,
    currentStatus: string,
  ): Promise<void> {
    const mapping = DOCUMENT_TYPES[typeCode];
    // `conflictStatus` 는 400 이다 — 사유는 `evaluate()` 가 앞에서 이미 갈랐고 이것은 경합 그물이다.
    const transition = this.documentState.assertTransition(
      `${DOCUMENT_SCHEMA}.${mapping.delegate}.status_code`,
      REQUEST_CANCEL,
      currentStatus,
      HttpStatus.BAD_REQUEST,
    );
    await this.applyStatus(tx, mapping, documentId, version, transition.to);
  }

  /** 상태 한 칸 + `version_no +1` 을 토큰 대조와 «한 문장»으로 쓴다. 0행이면 409 다. */
  async applyStatus(
    tx: Prisma.TransactionClient,
    mapping: DocumentTypeMapping,
    documentId: bigint,
    version: number,
    to: string,
  ): Promise<void> {
    const updated = await this.delegate(tx, mapping.delegate).updateMany({
      where: { [mapping.idColumn]: documentId, [mapping.versionColumn]: version },
      data: { status_code: to, [mapping.versionColumn]: { increment: 1 } },
    });
    assertUpdated(updated.count);
  }

  /**
   * `FOR UPDATE` 한 문장. ⛔ 표 이름을 변수로 흘리지 않는다 — 유형마다 리터럴 문장을 둔다
   * (등록부·매핑의 문자열이 SQL 로 들어가지 않는다 · `document-type-registry.ts` 머리말).
   */
  async lockDocument(
    tx: Prisma.TransactionClient,
    typeCode: CancelableDocumentType,
    documentId: bigint,
  ): Promise<LockedRow | undefined> {
    switch (typeCode) {
      case 'INBOUND_RECEIPT':
        return (
          await tx.$queryRaw<LockedRow[]>`
            SELECT status_code, version_no FROM logistics.inbound_receipt
             WHERE inbound_receipt_id = ${documentId} FOR UPDATE`
        )[0];
      case 'GOODS_RECEIPT':
        return (
          await tx.$queryRaw<LockedRow[]>`
            SELECT status_code, version_no FROM logistics.goods_receipt
             WHERE goods_receipt_id = ${documentId} FOR UPDATE`
        )[0];
      default:
        return (
          await tx.$queryRaw<LockedRow[]>`
            SELECT status_code, version_no FROM logistics.goods_issue
             WHERE goods_issue_id = ${documentId} FOR UPDATE`
        )[0];
    }
  }

  private delegate(tx: Prisma.TransactionClient, name: string): WritableDelegate {
    return (tx as unknown as Record<string, WritableDelegate>)[name];
  }
}

/**
 * 경로 enum 3값 — 조회 축 9종 중 취소 실행 경로가 있는 셋이다(`cancelable` 과 같은 집합).
 * enum 밖 값은 계약 검증 가드가 이미 400 으로 막는다(경로 파라미터도 대조한다 · 상세 GET 선례)
 * — 이 가드는 그 뒤의 그물이라 타입 좁히기를 겸한다.
 */
export function isCancelableType(value: string): value is CancelableDocumentType {
  return DOCUMENT_TYPES[value as LogisticsDocumentType]?.cancelable === true;
}
