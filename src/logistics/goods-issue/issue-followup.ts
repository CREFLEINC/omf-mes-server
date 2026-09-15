import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';

/**
 * 출고 전기가 끝난 «뒤» 원천 전표를 정리한다 — 피킹 지시 닫기(P-14)와 요청 라인 기출고
 * 가산(P-16 · 문의 046). 둘 다 전기와 **같은 트랜잭션**에서 돈다.
 *
 * ⛔ `postIssue()` 안이 아니라 밖이다 — 그 함수는 원장 한 가지만 아는 자리이고, 출하(I-23)도
 * 그것을 부른다. 원천 전표 정리는 «출고 도메인»의 일이라 서비스 쪽에 둔다.
 */

const PICKING_STATUS_COLUMN = 'logistics.picking_order.status_code';
const PICKING_CLOSE_ACTION = 'picking-issue';
const REQUEST_STATUS_COLUMN = 'logistics.material_issue_request.status_code';
const REQUEST_CLOSE_ACTION = 'material-issue-request-issue';
const SOURCE_PICKING_ORDER = 'PICKING_ORDER';
const REGISTERED = 'REGISTERED';
const POSTED = 'POSTED';

export interface IssuedLine {
  /** 계약이 선택으로 둔 칸이라 비어 올 수 있다 — 비면 그 라인의 기출고는 안 오른다. */
  pickingLineId?: bigint | null;
  issueQty: Prisma.Decimal;
}

export interface FollowupInput {
  sourceDocumentTypeCode: string;
  sourceDocumentId: bigint;
  lines: readonly IssuedLine[];
  appUserId: number | undefined;
}

/**
 * ⭐ 전기 뒤에 부른다 — 이 출고가 이미 `POSTED` 여야 누적 출고량에 자기 몫이 들어간다.
 */
export async function followUpIssue(
  tx: Prisma.TransactionClient,
  documentState: DocumentStateService,
  input: FollowupInput,
): Promise<void> {
  if (input.sourceDocumentTypeCode !== SOURCE_PICKING_ORDER) return;
  await addIssuedQty(tx, documentState, input);
  await closePickingOrder(tx, documentState, input);
}

/**
 * 기출고 가산 — `goods_issue_line.picking_line_id → picking_line.material_issue_request_line_id`
 * 를 타고 요청 라인에 더한다(P-16).
 *
 * ⛔ 축이 비면 올리지 않는다 — 계약이 `pickingLineId` 를 선택으로 두었고, 짝이 없는 라인의
 * 몫을 품목으로 «지어내지» 않는다(문의 046 기준 4).
 * ⚠ `ck_material_issue_line_qty (issued_qty <= requested_qty)` 가 있다 — 넘치면 CHECK 위반이
 * `PrismaClientUnknownRequestError` 로 **500** 이 되므로 가산 «전»에 400 으로 막는다.
 */
async function addIssuedQty(
  tx: Prisma.TransactionClient,
  documentState: DocumentStateService,
  input: FollowupInput,
): Promise<void> {
  const pickingLineIds = [
    ...new Set(input.lines.flatMap((line) => (line.pickingLineId == null ? [] : [line.pickingLineId]))),
  ];
  if (pickingLineIds.length === 0) return;

  const pickingLines = await tx.picking_line.findMany({
    where: { picking_line_id: { in: pickingLineIds } },
    select: { picking_line_id: true, material_issue_request_line_id: true },
  });
  const requestLineOf = new Map(
    pickingLines.map((line) => [line.picking_line_id, line.material_issue_request_line_id]),
  );

  // 한 요청 라인이 LOT 별로 갈려 출고 라인 여럿이 될 수 있다 — 먼저 합친 뒤 한 번에 올린다.
  const added = new Map<bigint, Prisma.Decimal>();
  for (const line of input.lines) {
    if (line.pickingLineId == null) continue;
    const requestLineId = requestLineOf.get(line.pickingLineId) ?? null;
    if (requestLineId === null) continue;
    added.set(requestLineId, (added.get(requestLineId) ?? new Prisma.Decimal(0)).plus(line.issueQty));
  }
  if (added.size === 0) return;

  const targets = await tx.material_issue_request_line.findMany({
    where: { material_issue_request_line_id: { in: [...added.keys()] } },
    select: {
      material_issue_request_line_id: true,
      material_issue_request_id: true,
      line_no: true,
      requested_qty: true,
      issued_qty: true,
    },
  });

  const errors: ErrorItem[] = [];
  for (const target of targets) {
    const delta = added.get(target.material_issue_request_line_id) as Prisma.Decimal;
    if (target.issued_qty.plus(delta).greaterThan(target.requested_qty)) {
      errors.push(
        field(
          'lines',
          ERROR_CODE.RANGE,
          `요청 라인 ${target.line_no} 의 누적 출고가 요청 수량을 넘습니다.`,
        ),
      );
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  for (const target of targets) {
    await tx.material_issue_request_line.update({
      where: { material_issue_request_line_id: target.material_issue_request_line_id },
      data: {
        issued_qty: {
          increment: added.get(target.material_issue_request_line_id) as Prisma.Decimal,
        },
      },
    });
  }

  const requestIds = [...new Set(targets.map((target) => target.material_issue_request_id))];
  for (const requestId of requestIds) {
    await closeRequestIfFullyIssued(tx, documentState, requestId, input.appUserId);
  }
}

/**
 * 전 라인이 요청 수량만큼 나갔으면 요청을 닫는다. ⛔ 라인이 0건이면 옮기지 않는다 —
 * 「전 라인이 다 나갔다」가 공허한 참이 된다.
 */
async function closeRequestIfFullyIssued(
  tx: Prisma.TransactionClient,
  documentState: DocumentStateService,
  requestId: bigint,
  appUserId: number | undefined,
): Promise<void> {
  const request = await tx.material_issue_request.findUnique({
    where: { material_issue_request_id: requestId },
    select: { status_code: true },
  });
  if (request === null || request.status_code !== REGISTERED) return;

  const lines = await tx.material_issue_request_line.findMany({
    where: { material_issue_request_id: requestId },
    select: { requested_qty: true, issued_qty: true },
  });
  if (lines.length === 0) return;
  if (lines.some((line) => line.issued_qty.lessThan(line.requested_qty))) return;

  const transition = documentState.assertTransition(
    REQUEST_STATUS_COLUMN,
    REQUEST_CLOSE_ACTION,
    request.status_code,
    HttpStatus.BAD_REQUEST,
  );
  await tx.material_issue_request.update({
    where: { material_issue_request_id: requestId },
    data: {
      status_code: transition.to,
      version_no: { increment: 1 },
      updated_by: appUserId == null ? null : BigInt(appUserId),
    },
  });
}

/**
 * 피킹 지시 닫기(P-14) — **전 라인이 `planned_qty` 만큼 나갔을 때만** 옮긴다.
 *
 * ⛔ 첫 출고에서 닫지 않는다. 모바일은 출고 뒤에도 같은 지시를 다시 열어 나머지를 집고
 * (`M-01-08` 이 이미 나간 양을 빼고 초안을 짠다), 목록은 `statusCode=REGISTERED` 로 거른다 —
 * 부분 출고에서 닫으면 8/10 만 내보낸 작업자가 나머지 2 를 집으러 돌아올 길이 사라진다.
 * ⚠ 결품으로 영영 못 채우는 지시는 닫히지 않는다 — 사람이 닫는 오퍼레이션이 계약에 0건이고
 * `document-type-registry.ts` 도 `cancelable: false` 라 취소 경로도 없다(별건).
 */
async function closePickingOrder(
  tx: Prisma.TransactionClient,
  documentState: DocumentStateService,
  input: FollowupInput,
): Promise<void> {
  const order = await tx.picking_order.findUnique({
    where: { picking_order_id: input.sourceDocumentId },
    select: { status_code: true },
  });
  if (order === null || order.status_code !== REGISTERED) return;

  const lines = await tx.picking_line.findMany({
    where: { picking_order_id: input.sourceDocumentId },
    select: { picking_line_id: true, planned_qty: true },
  });
  if (lines.length === 0) return;

  // 누적 출고량은 **전기된 출고**만 센다 — 등록만 된 전표는 아직 나간 것이 아니다.
  const issued = await tx.goods_issue_line.groupBy({
    by: ['picking_line_id'],
    where: {
      picking_line_id: { in: lines.map((line) => line.picking_line_id) },
      goods_issue: { status_code: POSTED },
    },
    _sum: { issue_qty: true },
  });
  const issuedOf = new Map(issued.map((row) => [row.picking_line_id, row._sum.issue_qty]));
  const done = lines.every((line) => {
    const sum = issuedOf.get(line.picking_line_id) ?? null;
    return sum !== null && sum.greaterThanOrEqualTo(line.planned_qty);
  });
  if (!done) return;

  const transition = documentState.assertTransition(
    PICKING_STATUS_COLUMN,
    PICKING_CLOSE_ACTION,
    order.status_code,
    HttpStatus.BAD_REQUEST,
  );
  await tx.picking_order.update({
    where: { picking_order_id: input.sourceDocumentId },
    data: {
      status_code: transition.to,
      version_no: { increment: 1 },
      updated_by: input.appUserId == null ? null : BigInt(input.appUserId),
    },
  });
}
