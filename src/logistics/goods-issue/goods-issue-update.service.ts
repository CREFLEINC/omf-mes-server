import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { ApprovalService } from '../../core/approval';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsIssueLineCreate, REGISTERED, lineTargetErrors } from './goods-issue-rules';
import { GoodsIssueLineView, goodsIssueLineView } from './goods-issue-view';
import { APPROVAL_TYPE, TARGET_TYPE } from './goods-issue.service';

/**
 * 치환에서 살아 남는 라인의 `line_no` 를 잠시 밀어 두는 폭. 1↔2 맞바꾸기가
 * `uq_goods_issue_line(goods_issue_id, line_no)` 를 «중간 상태»에서 깬다 — 그 제약이
 * `condeferrable=f` 라 문장 끝마다 본다(실측). 한 문장으로 같은 폭만큼 밀어 두고(그 사이에도
 * 서로 유일하다) 최종 1..N 을 다시 준다. `CHECK (line_no > 0)` 이라 음수로는 못 민다
 * (P/O `replaceLines` · 입하 선례).
 */
const LINE_NO_SHIFT = 1_000_000;

/** 잠근 헤더에서 판정에 쓰는 칸만. */
interface LockedHeader {
  status_code: string;
  version_no: number;
}

/**
 * 출고 라인 치환 + 기타 출고 품의 상신. 등록·전기는 `GoodsIssueService`, 조회는
 * `GoodsIssueQueryService` 다 — 등록·전기가 이미 300줄을 넘어 갈랐다(입하
 * `inbound-receipt-update.service.ts` 선례).
 */
@Injectable()
export class GoodsIssueUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * ⛔ 잠그는 단위가 «부모»다 — If-Match 는 `goods_issue.version_no` 이고 계약이 그 이유를
   *   적었다(「잠그는 단위가 부모이기 때문이다」 · B-1-1). 라인에는 버전이 없다.
   * ⛔ 읽고 쓰는 것이 한 `$transaction` 이어야 한다 — 1↔2 맞바꾸기가 중간 상태에서
   *   `uq_goods_issue_line` 을 깬다.
   * ⛔ 응답에 ETag 가 없다(계약 미선언). 그래도 부모 `version_no` 는 «올린다» — 라인이
   *   바뀌면 부모 상세의 내용이 바뀐다. 다음 If-Match 는 상세 GET 이 준다(I-4.md §6-3).
   * ⚠ `inventory_transaction_line_id` 를 건드릴 자리가 없다 — `REGISTERED` 전표라 늘 널이다.
   */
  async replaceLines(
    goodsIssueId: number,
    version: number,
    items: GoodsIssueLineCreate[],
    appUserId: number,
  ): Promise<{ items: GoodsIssueLineView[]; versionNo: number }> {
    // 계약이 `minItems` 를 안 걸었다 — 등록이 「최소 1행」이라 적힌 자리와 같은 자원이라
    // 치환도 0행을 막는다(등록 `assertCreatable` 과 같은 판정).
    if (items.length === 0) {
      throw one(field('items', ERROR_CODE.LINE_REQUIRED, '출고 라인이 1건 이상이어야 합니다.'));
    }
    assertNoDuplicate(items);
    // ⚠ 출발 창고는 어느 오퍼레이션도 바꾸지 않는다 — 잠그기 «전»에 읽어도 잠근 값과 같다.
    //   위치↔창고 검사가 그 값을 쓰므로 여기서 한 번 읽고 트랜잭션 밖에서 FK 를 다 본다
    //   (등록과 같은 순서 — 없는 id 를 그냥 넘기면 FK 위반이 500 으로 샌다).
    const header = await this.prisma.goods_issue.findUnique({
      where: { goods_issue_id: goodsIssueId },
      select: { source_warehouse_id: true },
    });
    if (header === null) throw new NotFoundException('없는 출고 전표입니다.');
    const errors = await lineTargetErrors(
      this.prisma,
      items,
      Number(header.source_warehouse_id),
      'items',
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const lines = await this.prisma.$transaction(async (tx) => {
      const locked = await lockHeader(tx, goodsIssueId, version);
      assertRegistered(locked.status_code, '라인을 고칠');
      // ⛔ 승인 대기 중에는 막는다 — 승인자가 본 것과 전기되는 것이 달라진다. 원장은
      //    되돌릴 수 없다(역트랜잭션은 I-5 다). P/O(문의 023)는 같은 구멍을 열어 뒀는데,
      //    거기엔 `:post` 가 없어 승인 뒤에 일어나는 일이 계약에 0건이라 되돌림 비용이
      //    다르다(I-4.md §4-4 · 문의 030 갈래 ②).
      await this.approvals.assertNoOpenRequest(
        tx,
        TARGET_TYPE,
        BigInt(goodsIssueId),
        APPROVAL_TYPE,
      );
      // ⛔ 승인이 «끝난» 뒤에도 막는다 — `assertApproved` 는 시각 순서를 안 봐서 승인 뒤 바꾼 라인이
      //    그대로 원장에 나간다. 승인을 되무르는 경로가 계약에 없어 전기 전까지 라인은 얼어 있다.
      await assertNotApproved(tx, goodsIssueId);

      const existing = await tx.goods_issue_line.findMany({
        where: { goods_issue_id: goodsIssueId },
        select: { goods_issue_line_id: true },
      });
      const known = new Set(existing.map((row) => Number(row.goods_issue_line_id)));
      assertOwnLines(items, known);

      // 계약 「요청에서 빠진 기존 행은 삭제한다」.
      const requested = new Set(items.map((item) => item.goodsIssueLineId));
      const removed = existing
        .filter((row) => !requested.has(Number(row.goods_issue_line_id)))
        .map((row) => row.goods_issue_line_id);
      if (removed.length > 0) {
        await tx.goods_issue_line.deleteMany({ where: { goods_issue_line_id: { in: removed } } });
      }
      await tx.$executeRaw`
        UPDATE logistics.goods_issue_line
           SET line_no = line_no + ${LINE_NO_SHIFT}
         WHERE goods_issue_id = ${BigInt(goodsIssueId)}`;

      for (const [index, item] of items.entries()) {
        const values = {
          // 「서버가 부여하며 화면이 정하지 않는다」(계약 `GoodsIssueLine.lineNo`) — 요청 순서다.
          line_no: index + 1,
          picking_line_id: item.pickingLineId ?? null,
          item_id: item.itemId,
          lot_id: item.lotId,
          issue_qty: item.issueQty,
          uom_id: item.uomId,
          source_location_id: item.sourceLocationId,
        };
        if (item.goodsIssueLineId == null) {
          await tx.goods_issue_line.create({
            data: { goods_issue_id: goodsIssueId, created_by: BigInt(appUserId), ...values },
          });
        } else {
          // ⚠ `updated_by` 칸이 «없다» — 라인에는 수정 감사 칸이 아예 없고 부모
          //   `goods_issue.updated_by` 가 그 자리를 담는다(아래 버전 범프).
          await tx.goods_issue_line.update({
            where: { goods_issue_line_id: item.goodsIssueLineId },
            data: values,
          });
        }
      }

      const bumped = await tx.goods_issue.updateMany({
        where: { goods_issue_id: goodsIssueId, version_no: version },
        data: { version_no: { increment: 1 }, updated_by: BigInt(appUserId) },
      });
      // 잠그고 비교했으니 0행일 수 없다 — 그래도 조건을 걸어 둔다(같은 축의 마지막 그물).
      assertUpdated(bumped.count);

      const rows = await tx.goods_issue_line.findMany({
        where: { goods_issue_id: goodsIssueId },
        orderBy: { line_no: 'asc' },
      });
      return rows.map(goodsIssueLineView);
    });

    return { items: lines, versionNo: version + 1 };
  }

  /**
   * 상신. P/O `requestApproval` 의 복제고 다른 점은 셋이다 — 대상·유형 코드,
   * `businessUnitId` 가 **널**(8자리 공통본 · `reasonCode` → 결재선 매핑이 계약 미정 ·
   * 문의 022), 그리고 상태 가드다.
   *
   * ⛔ 상태를 «안 옮긴다» — 승인 진행은 `approval_request.status_code` 가 진다.
   * ⛔ `version_no` 를 «올리지 않는다» — 202 에 ETag 가 없어 화면이 새 토큰을 받을 길이
   *   없고, 올리면 다음 쓰기가 상세 GET 을 다시 돌 때까지 영원히 409 다(§6-3).
   * ⛔ 그래도 «읽고 비교는 한다» — 안 그러면 계약이 선언한 409 가 도달 불가능해진다.
   * ⛔ 버전을 안 올리니 낙관적 잠금이 동시 상신을 못 가른다 — 트랜잭션 첫 문장에서 헤더를
   *   `FOR UPDATE` 로 잠그는 것이 그 자리다(`assertNoOpenRequest` 는 조회만 한다).
   */
  async requestApproval(
    goodsIssueId: number,
    version: number,
    reason: string,
    appUserId: number,
  ): Promise<{ approvalRequestId: number }> {
    const exists = await this.prisma.goods_issue.findUnique({
      where: { goods_issue_id: goodsIssueId },
      select: { status_code: true },
    });
    if (exists === null) throw new NotFoundException('없는 출고 전표입니다.');
    // 채번 «전»에 한 번 거른다 — 전기된 전표에 상신을 되풀이하면 AP 번호만 빈다. 잠근 뒤 재검사는 경합 몫.
    assertRegistered(exists.status_code, '상신할');

    // ⛔ 채번은 `$transaction` 을 «열기 전»에 부른다 — 열린 트랜잭션 안에서 부르면 이 요청이
    //    커넥션을 둘 쥐고, 동시 요청이 풀을 채우면 P2024 로 죽는다(P/O :288 그대로).
    // ⚠ 기간키가 UTC 라 하노이(UTC+7) 00:00–07:00 의 상신은 «전날» 번호를 받는다. 이 표는
    //   `business_date` 를 안 실어 C-8 자리가 아니다 — AP 번호의 날짜를 현지 영업일로 읽지 말 것.
    const approvalRequestNo = await this.numbering.next(
      'APPROVAL_REQUEST',
      null,
      new Date().toISOString().slice(0, 10),
    );

    const approvalRequestId = await this.prisma.$transaction(async (tx) => {
      const locked = await lockHeader(tx, goodsIssueId, version);
      // ⚠ 계약이 `:request-approval` 에 상태 조건을 «안 적었다» — 전기된 전표의 상신은
      //   무의미하므로 막는다(§2 2단계 기준 2 「거부하는 쪽」 · I-4.md §8-1 ⓖ).
      assertRegistered(locked.status_code, '상신할');

      // 「진행 중인 승인 요청이 이미 있으면 400」·결재선 선택·단계 전개를 코어가 한 번에
      // 한다 — `assertNoOpenRequest`·`selectRoute` 를 여기서 다시 부르지 않는다.
      const created = await this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: APPROVAL_TYPE,
        targetTypeCode: TARGET_TYPE,
        targetId: BigInt(goodsIssueId),
        // ⚠ 9 상신자 중 P/O 만 전표 값을 준다 — 나머지 여덟은 공통본 널이다(문의 022).
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason,
      });
      // ⛔ 표시용 FK 다 — 승인 판정은 언제나 다형 축(`assertApproved`)으로 한다. 이 칸은
      //    I-5 의 취소 품의가 덮어쓴다(plan.md §5 #12 · I-4.md §4-2).
      await tx.goods_issue.update({
        where: { goods_issue_id: goodsIssueId },
        data: { approval_request_id: created.approvalRequestId },
      });
      return created.approvalRequestId;
    });

    return { approvalRequestId: Number(approvalRequestId) };
  }
}

/** 헤더를 잠그고 버전을 대조한다 — 치환·상신이 같은 첫 문장을 쓴다. */
async function lockHeader(
  tx: Prisma.TransactionClient,
  goodsIssueId: number,
  version: number,
): Promise<LockedHeader> {
  const [locked] = await tx.$queryRaw<LockedHeader[]>`
    SELECT status_code, version_no
      FROM logistics.goods_issue
     WHERE goods_issue_id = ${BigInt(goodsIssueId)}
       FOR UPDATE`;
  if (locked === undefined) throw new NotFoundException('없는 출고 전표입니다.');
  // 존재는 확인했다 — 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 풀린다).
  if (locked.version_no !== version) assertUpdated(0);
  return locked;
}

/** 계약 문자 그대로 400 이다 — 409 는 If-Match 저장 충돌 전용이다(`approval.service.ts:263`). */
/** 승인이 끝난(전기 전) 전표의 라인 자물쇠 — 재로드로 풀리지 않으니 `STATE_LOCKED` 다. */
async function assertNotApproved(
  tx: Prisma.TransactionClient,
  goodsIssueId: number,
): Promise<void> {
  const approved = await tx.approval_request.findFirst({
    where: {
      target_type_code: TARGET_TYPE,
      target_id: BigInt(goodsIssueId),
      approval_type_code: APPROVAL_TYPE,
      status_code: 'APPROVED',
    },
    select: { approval_request_id: true },
  });
  if (approved !== null) {
    throw one(field('items', ERROR_CODE.STATE_LOCKED, '승인이 끝난 출고의 라인은 고칠 수 없습니다.'));
  }
}

function assertRegistered(statusCode: string, what: string): void {
  if (statusCode !== REGISTERED) {
    throw one(field('statusCode', ERROR_CODE.STATE_LOCKED, `등록 상태에서만 ${what} 수 있습니다.`));
  }
}

/** 같은 라인을 두 번 실으면 같은 행에 `update` 가 두 번 걸려 요청 N건이 응답 N-1건으로 줄고도
 *  200 이다 — 유일 제약도 CHECK 도 안 걸려 DB 가 못 잡는다(P/O #194 리뷰 Major-1). */
function assertNoDuplicate(items: GoodsIssueLineCreate[]): void {
  const seen = new Set<number>();
  for (const [index, item] of items.entries()) {
    const lineId = item.goodsIssueLineId;
    if (lineId == null) continue;
    if (seen.has(lineId)) {
      throw one(at(index, ERROR_CODE.INVALID, '같은 라인을 두 번 실었습니다.'));
    }
    seen.add(lineId);
  }
}

/** 짚는 행이 «없으면»(다른 전표의 라인) 조용한 사고가 된다 — 남의 라인을 이 전표로 끌어온다. */
function assertOwnLines(items: GoodsIssueLineCreate[], known: Set<number>): void {
  const errors: ErrorItem[] = [];
  for (const [index, item] of items.entries()) {
    if (item.goodsIssueLineId != null && !known.has(item.goodsIssueLineId)) {
      errors.push(at(index, ERROR_CODE.INVALID, '이 출고 전표의 라인이 아닙니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function at(index: number, code: string, message: string): ErrorItem {
  return field(`items[${index}].goodsIssueLineId`, code, message);
}
