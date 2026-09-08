import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { ApprovalService } from '../../core/approval';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  APPROVAL_TYPE,
  InventoryAdjustmentLineCreate,
  REGISTERED,
  TARGET_TYPE,
  assertReplaceable,
} from './inventory-adjustment-rules';
import { InventoryAdjustmentLineView, inventoryAdjustmentLineView } from './inventory-adjustment-view';

/** 1↔2 맞바꾸기가 `uq_inventory_adjustment_line`(`condeferrable=f`)을 «중간 상태»에서 깬다 —
 *  한 문장으로 같은 폭만큼 밀어 두고 최종 1..N 을 다시 준다(출고 선례 · `CHECK line_no > 0`). */
const LINE_NO_SHIFT = 1_000_000;

interface LockedHeader {
  status_code: string;
  version_no: number;
}

/**
 * 재고 조정 라인 치환 + 상신 — 출고 `goods-issue-update.service.ts` 의 거울상이다.
 * ⛔ 조정에는 취소·역분개 경로가 «아예 없다»(계약에 0건 · 결정 — 통보 132).
 */
@Injectable()
export class InventoryAdjustmentUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * ⛔ 잠그는 단위가 «부모»다 — If-Match 는 `inventory_adjustment.version_no` 고 라인에는
   *   버전이 없다(계약 「잠그는 단위가 부모이기 때문이다」 · B-1-1).
   * ⭐ 출고와 갈리는 한 자리 — 계약이 200 에 ETag 를 «선언했다»(「라인을 고치면 이 헤더의
   *   값이 오르므로 다음 상태 전이는 이 값을 쓴다 — 상세 GET 을 다시 돌지 않는다」).
   */
  async replaceLines(
    inventoryAdjustmentId: number,
    version: number,
    items: InventoryAdjustmentLineCreate[],
    appUserId: number,
  ): Promise<{ items: InventoryAdjustmentLineView[]; versionNo: number }> {
    // ⚠ 헤더의 실사 축·사유는 어느 오퍼레이션도 바꾸지 않는다 — 잠그기 «전»에 읽어도 잠근
    //   값과 같다. 없는 id 를 그냥 넘기면 FK 위반이 500 으로 샌다(등록과 같은 순서).
    const header = await this.prisma.inventory_adjustment.findUnique({
      where: { inventory_adjustment_id: inventoryAdjustmentId },
      select: { inventory_count_id: true, reason_code: true, status_code: true },
    });
    if (header === null) throw new NotFoundException('없는 재고 조정입니다.');
    // ⛔ 잔액을 읽기 «전»에 상태를 거른다 — 전기가 그 위치 재고를 소진했으면 아래
    //    `assertReplaceable` 이 먼저 400 `NEGATIVE_BALANCE` 를 내어, 계약이 이 자리에
    //    못박은 400 `STATE_LOCKED` 가 도달 불가능해진다(§6-3 1행 · 상신도 같은 순서다).
    assertRegistered(header.status_code, '라인을 고칠');
    const count = header.inventory_count_id;
    const dimensions = await assertReplaceable(this.prisma, items, count === null ? null : Number(count));
    const targetId = BigInt(inventoryAdjustmentId);

    return this.prisma.$transaction(async (tx) => {
      const locked = await lockHeader(tx, inventoryAdjustmentId, version);
      assertRegistered(locked.status_code, '라인을 고칠');
      // ⛔ 승인 대기 중·승인 완료 뒤 둘 다 막는다 — 승인자가 본 것과 전기되는 것이 달라지고,
      //    조정은 취소 경로가 아예 없어 원장을 되돌릴 방법이 0 이다(출고보다 강한 이유다).
      await this.approvals.assertNoOpenRequest(tx, TARGET_TYPE, targetId, APPROVAL_TYPE);
      await assertNotApproved(tx, targetId);
      const existing = await tx.inventory_adjustment_line.findMany({
        where: { inventory_adjustment_id: inventoryAdjustmentId },
        select: { inventory_adjustment_line_id: true },
      });
      assertOwnLines(items, new Set(existing.map((row) => Number(row.inventory_adjustment_line_id))));

      // 계약 「요청에서 빠진 기존 행은 삭제한다」.
      const requested = new Set(items.map((item) => item.inventoryAdjustmentLineId));
      const removed = existing
        .filter((row) => !requested.has(Number(row.inventory_adjustment_line_id)))
        .map((row) => row.inventory_adjustment_line_id);
      if (removed.length > 0) {
        await tx.inventory_adjustment_line.deleteMany({ where: { inventory_adjustment_line_id: { in: removed } } });
      }
      await tx.$executeRaw`
        UPDATE inventory.inventory_adjustment_line
           SET line_no = line_no + ${LINE_NO_SHIFT}
         WHERE inventory_adjustment_id = ${BigInt(inventoryAdjustmentId)}`;

      for (const [index, item] of items.entries()) {
        const values = {
          // 「서버가 부여하며 화면이 정하지 않는다」(계약 `InventoryAdjustmentLine.lineNo`).
          line_no: index + 1,
          location_id: item.locationId,
          item_id: item.itemId,
          lot_id: item.lotId ?? null,
          // 치환 «시점»의 잔액 행에서 다시 읽은 값이다(결정 — 통보 130).
          quality_status_code: dimensions[index].qualityStatusCode,
          inventory_status_code: dimensions[index].inventoryStatusCode,
          adjustment_qty: item.adjustmentQty,
          uom_id: item.uomId,
          // 계약 「헤더와 «같은 축»이다」 — 안 보낸 라인은 헤더 사유를 물려받는다(§5-3).
          reason_code: item.reasonCode ?? header.reason_code,
          inventory_count_line_id: item.inventoryCountLineId ?? null,
        };
        const id = item.inventoryAdjustmentLineId;
        // ⚠ 라인에 수정 감사 칸이 «없다» — 부모 `updated_by` 가 그 자리를 담는다.
        if (id == null) {
          await tx.inventory_adjustment_line.create({
            data: { inventory_adjustment_id: inventoryAdjustmentId, created_by: appUserId, ...values },
          });
        } else {
          await tx.inventory_adjustment_line.update({ where: { inventory_adjustment_line_id: id }, data: values });
        }
      }

      const bumped = await tx.inventory_adjustment.updateMany({
        where: { inventory_adjustment_id: inventoryAdjustmentId, version_no: version },
        data: { version_no: { increment: 1 }, updated_by: appUserId },
      });
      // 잠그고 비교했으니 0행일 수 없다 — 그래도 조건을 걸어 둔다(같은 축의 마지막 그물).
      assertUpdated(bumped.count);
      // ⭐ ETag 로 나갈 값을 «되읽는다» — 계약이 「다음 상태 전이는 이 값을 쓴다」고 못박아
      //    한 번이라도 어긋나면 그 뒤 쓰기가 상세 GET 을 다시 돌 때까지 영원히 409 다.
      const after = await tx.inventory_adjustment.findUniqueOrThrow({
        where: { inventory_adjustment_id: inventoryAdjustmentId },
        select: { version_no: true },
      });
      const rows = await tx.inventory_adjustment_line.findMany({
        where: { inventory_adjustment_id: inventoryAdjustmentId },
        orderBy: { line_no: 'asc' },
      });
      return { items: rows.map(inventoryAdjustmentLineView), versionNo: after.version_no };
    });
  }

  /**
   * 상신. 출고 `requestApproval` 의 복제고 다른 것은 대상·승인 유형과 잠그는 표뿐이다.
   * ⛔ 상태를 «안 옮기고» `version_no` 도 «안 올린다» — 202 에 ETag 가 없어 화면이 새 토큰을
   *   받을 길이 없다. 올리면 다음 쓰기가 상세 GET 을 다시 돌 때까지 영원히 409 다.
   * ⛔ 그래도 «읽고 비교는 한다» — 안 그러면 계약이 선언한 409 가 도달 불가능해진다. 동시
   *   상신을 가르는 것은 트랜잭션 첫 문장의 `FOR UPDATE` 다(I-2.md R-4).
   */
  async requestApproval(
    inventoryAdjustmentId: number,
    version: number,
    reason: string,
    appUserId: number,
  ): Promise<{ approvalRequestId: number }> {
    const exists = await this.prisma.inventory_adjustment.findUnique({
      where: { inventory_adjustment_id: inventoryAdjustmentId },
      select: { status_code: true },
    });
    if (exists === null) throw new NotFoundException('없는 재고 조정입니다.');
    // 채번 «전»에 한 번 거른다 — 전기된 전표에 상신을 되풀이하면 AP 번호만 빈다.
    assertRegistered(exists.status_code, '상신할');

    // ⛔ 채번은 `$transaction` 을 «열기 전»에 부른다 — 열린 트랜잭션 안에서 부르면 한 요청이
    //    커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2.md R-2).
    // ⚠ 기간키가 UTC 라 하노이(UTC+7) 00:00–07:00 의 상신은 «전날» 번호를 받는다(C-8 자리 아님).
    const today = new Date().toISOString().slice(0, 10);
    const approvalRequestNo = await this.numbering.next('APPROVAL_REQUEST', null, today);

    const approvalRequestId = await this.prisma.$transaction(async (tx) => {
      const locked = await lockHeader(tx, inventoryAdjustmentId, version);
      // ⚠ 계약이 `:request-approval` 에 상태 조건을 «안 적었다» — 전기된 전표의 상신은
      //   무의미하므로 막는다(README §2 2단계 기준 2 「거부하는 쪽」).
      assertRegistered(locked.status_code, '상신할');
      // 「진행 중인 요청이 이미 있으면 400」·결재선 선택·단계 전개를 코어가 한 번에 한다.
      const created = await this.approvals.request(tx, {
        approvalRequestNo,
        approvalTypeCode: APPROVAL_TYPE,
        targetTypeCode: TARGET_TYPE,
        targetId: BigInt(inventoryAdjustmentId),
        // ⚠ 9 상신자 중 P/O 만 전표 값을 준다 — 나머지 여덟은 공통본 널이다(문의 022).
        businessUnitId: null,
        requestedBy: BigInt(appUserId),
        reason,
      });
      // ⛔ 표시용 FK 다 — 승인 판정은 언제나 다형 축이다(plan.md §5 #12).
      await tx.inventory_adjustment.update({
        where: { inventory_adjustment_id: inventoryAdjustmentId },
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
  inventoryAdjustmentId: number,
  version: number,
): Promise<LockedHeader> {
  const [locked] = await tx.$queryRaw<LockedHeader[]>`
    SELECT status_code, version_no
      FROM inventory.inventory_adjustment
     WHERE inventory_adjustment_id = ${BigInt(inventoryAdjustmentId)}
       FOR UPDATE`;
  if (locked === undefined) throw new NotFoundException('없는 재고 조정입니다.');
  // 존재는 확인했다 — 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 풀린다).
  if (locked.version_no !== version) assertUpdated(0);
  return locked;
}

/** 승인이 끝난(전기 전) 전표의 라인 자물쇠 — `assertApproved` 는 시각 순서를 안 봐 승인 뒤
 *  바꾼 라인이 원장에 나간다. 재로드로 안 풀리니 400 `STATE_LOCKED` 다(409 는 저장 충돌 전용). */
async function assertNotApproved(tx: Prisma.TransactionClient, targetId: bigint): Promise<void> {
  const approved = await tx.approval_request.findFirst({
    where: {
      target_type_code: TARGET_TYPE,
      target_id: targetId,
      approval_type_code: APPROVAL_TYPE,
      status_code: 'APPROVED',
    },
    select: { approval_request_id: true },
  });
  if (approved !== null) {
    throw one(field('items', ERROR_CODE.STATE_LOCKED, '승인이 끝난 조정의 라인은 고칠 수 없습니다.'));
  }
}

function assertRegistered(statusCode: string, what: string): void {
  if (statusCode !== REGISTERED) {
    throw one(field('statusCode', ERROR_CODE.STATE_LOCKED, `등록 상태에서만 ${what} 수 있습니다.`));
  }
}

/**
 * ⛔ 같은 라인을 두 번 실으면 같은 행에 `update` 가 두 번 걸려 요청 N건이 응답 N-1건으로
 *   줄고도 200 이다 — 유일 제약도 CHECK 도 안 걸려 DB 가 못 잡는다.
 * ⛔ 짚는 행이 «없으면»(남의 전표 라인) 그 라인을 이 전표로 끌어온다.
 */
function assertOwnLines(items: InventoryAdjustmentLineCreate[], known: Set<number>): void {
  const errors: ErrorItem[] = [];
  const seen = new Set<number>();
  for (const [index, item] of items.entries()) {
    const lineId = item.inventoryAdjustmentLineId;
    if (lineId == null) continue;
    const at = `items[${index}].inventoryAdjustmentLineId`;
    if (seen.has(lineId)) errors.push(field(at, ERROR_CODE.INVALID, '같은 라인을 두 번 실었습니다.'));
    else if (!known.has(lineId)) errors.push(field(at, ERROR_CODE.INVALID, '이 조정 전표의 라인이 아닙니다.'));
    seen.add(lineId);
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
