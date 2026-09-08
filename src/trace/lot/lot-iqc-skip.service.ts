import { Injectable, NotFoundException } from '@nestjs/common';

import { ERROR_CODE, field, one } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { INITIAL_LOT_STATUS, Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { assertWorkerNo } from './lot-rules';

/** 승인 다형 축 — 계약 `x-internal-note` 가 이 둘을 서버 몫으로 못 박았다. */
const IQC_SKIP_TYPE = 'IQC_SKIP';
const IQC_SKIP_TARGET_TYPE = 'INBOUND_LOT';
/** 계약 「**입하돼** 수입검사 대기인 LOT」의 앞 절반 — `:complete` 의 「생산 LOT 만」의 거울이다. */
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';

/** 자격 판정에 쓰는 두 칸 — 채번 «전» 사전 확인과 잠근 «뒤» 재검사가 같은 모양을 본다. */
export interface LotQualification {
  source_type_code: string;
  status_code: string;
}

/** 본문 밖에서 오는 것. ⚠ 주체는 세션 계정이다 — 사번은 읽고 버린다(`plan.md` §5 규칙 9). */
export interface IqcSkipContext {
  workerNo: string | undefined;
  appUserId: number;
}

/**
 * 긴급 IQC 생략 «요청»(I-18 PR ②). 승인 요청만 만들고 실행은 승인 뒤 다른 화면 몫이다
 * (공유계약 J-8 「승인은 자물쇠를 풀 뿐 실행하지 않는다」).
 *
 * ⛔ **대상 행에 아무것도 안 쓴다** — `trace.lot` 에 `approval_request_id` 칸이 «없고»
 *    `plan.md` §5 규칙 12 가 「`IQC_SKIP` 은 FK 를 쓰지 않는다 — 정본은 다형 축」이라 못 박았다.
 *    형제 둘(P/O · 출고)이 표시용 FK 를 채우는 자리에서 여기가 갈린다.
 * ⛔ `lot.version_no` 도 안 올린다 — 202 에 ETag 가 없어 화면이 새 토큰을 받을 길이 없다
 *    (`goods-issue-update.service.ts:161-166` 과 같은 이유).
 * ⛔ `lot.status_code` 를 안 옮긴다 — 전이 0건이다.
 */
@Injectable()
export class LotIqcSkipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
  ) {}

  async requestSkip(
    lotId: number,
    reason: string,
    context: IqcSkipContext,
  ): Promise<{ approvalRequestId: number }> {
    assertWorkerNo(context.workerNo);
    // 존재·자격을 채번 «전»에 한 번 거른다 — 400 이 될 LOT 에 AP 번호를 태우면 결번만 남는다
    // (I-5 R-12). 잠근 뒤 재검사가 경합 몫이다(형제 `goods-issue-update.service.ts:176-178`).
    const current = await this.prisma.lot.findUnique({
      where: { lot_id: lotId },
      select: { source_type_code: true, status_code: true },
    });
    if (current === null) throw new NotFoundException('없는 LOT 입니다.');
    assertSkippable(current);

    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 열린 트랜잭션 안에서 부르면 이 요청이 커넥션을
    //    둘 쥐고, 동시 요청이 풀을 채우면 P2024 로 죽는다(I-2 R-2 · `purchase-order.service.ts:288`).
    // ⚠ 기간키가 UTC 라 하노이(UTC+7) 00:00–07:00 의 상신은 «전날» 번호를 받는다. 이 표는
    //   `business_date` 를 안 실어 C-8 자리가 아니다 — AP 번호의 날짜를 현지 영업일로 읽지 말 것.
    const approvalRequestNo = await this.numbering.next(
      'APPROVAL_REQUEST',
      null,
      new Date().toISOString().slice(0, 10),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const locked = await lockLot(tx, lotId);
      assertSkippable(locked);
      // 「진행 중인 요청은 하나」·결재선 선택·단계 전개를 코어가 한 번에 한다 — 여기서 다시
      // 부르지 않고, 코어가 던지는 `ROUTE_NOT_FOUND`·`APPROVAL_IN_PROGRESS` 를 감싸지도 않는다.
      return this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: IQC_SKIP_TYPE,
        targetTypeCode: IQC_SKIP_TARGET_TYPE,
        targetId: BigInt(lotId),
        // ⚠ 9 상신자 중 P/O 만 전표 값을 준다 — LOT 에는 사업부 축이 없다(문의 022).
        businessUnitId: null,
        requestedBy: BigInt(context.appUserId),
        reason,
      });
    });
    return { approvalRequestId: Number(created.approvalRequestId) };
  }
}

/**
 * ⭐ 계약 「**입하돼 수입검사 대기인** LOT 에 대해」의 두 축 — 거부 코드가 «갈린다».
 * 같은 자원의 형제가 이미 그렇게 갈랐다: 원천 유형 위반은 `INVALID`(`lot-complete.service.ts:67-69`),
 * 상태 위반은 `STATE_LOCKED`(`:71-73`). 앞은 「이 경로가 다룰 대상이 아니다」이고 뒤는 「대상이지만
 * 지금은 그 상태가 아니다」라 화면이 두 사유를 다르게 읽는다.
 *
 * ⛔ 열린 `INCOMING_INSPECTION_WAIT` 보류의 «유무»는 보지 않는다 — I-19 `:confirm` 이 그 보류를
 *    닫으므로 검사 «중»인 LOT 이 정당하게 막힌다(통보 150).
 */
export function assertSkippable(lot: LotQualification): void {
  if (lot.source_type_code !== INBOUND_LOT_SOURCE) {
    throw one(field('lotId', ERROR_CODE.INVALID, '입하 LOT 만 IQC 생략을 요청할 수 있습니다.'));
  }
  if (lot.status_code !== INITIAL_LOT_STATUS) {
    throw one(
      field('lotId', ERROR_CODE.STATE_LOCKED, '수입검사 대기 LOT 만 IQC 생략을 요청할 수 있습니다.'),
    );
  }
}

/**
 * ⛔ 잠금이 «필수»다 — 코어의 `assertNoOpenRequest` 는 조회만 하므로 같은 순간의 상신 둘이 다
 * 통과한다(`approval.service.ts:98-100` 이 「호출자가 트랜잭션 첫 문장에서 대상 행을 잠근다」).
 */
async function lockLot(tx: Tx, lotId: number): Promise<LotQualification> {
  const rows = await tx.$queryRaw<LotQualification[]>`
    SELECT source_type_code, status_code
      FROM trace.lot
     WHERE lot_id = ${BigInt(lotId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 LOT 입니다.');
  return rows[0];
}
