import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { NumberingService } from '../../core/numbering';
import { PickingPlan, planPicking, writePicking } from '../../core/picking';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MaterialIssueRequestDetail,
  materialIssueRequestLineView,
  materialIssueRequestView,
} from './material-issue-request-view';
import { ISSUE_REQUEST_REGISTERED } from './material-issue-request.constants';

/** 계약 `MaterialIssueRequestCreateLine` — required 3. `bomComponentId` 가 비면 BOM 밖 품목이다. */
export interface MaterialIssueRequestCreateLine {
  bomComponentId?: number | null;
  itemId: number;
  requestedQty: number;
  uomId: number;
}

/** 계약 `MaterialIssueRequestCreate` — required 5 · 선택 3. */
export interface MaterialIssueRequestCreate {
  workOrderId: number;
  destinationLocationId: number;
  requiredAt?: string | null;
  reasonCode?: string | null;
  remarks?: string | null;
  lines: MaterialIssueRequestCreateLine[];
  businessDate: string;
  occurredAt: string;
}

/**
 * 새 요청을 막는 W/O 상태 — 8값(`transitions.ts:150-161`) 중 둘이다.
 * ⛔ `COMPLETED` 는 **연다** — 마감 전이라 정정 출고가 선다. 거부하면 업무를 없앤다(R-13).
 */
const STATE_LOCKED = new Set(['CANCELLED', 'CLOSED']);

/**
 * 추가 자재 출고 요청 발행(`W-02-10` §5-6). 자동 발행(`work-order-release.service.ts`)과
 * 공유하는 것은 상태 상수와 피킹 지시 생성 코어(`core/picking` · P-12)다 — 라인의 출처가 달라
 * 도메인 간 호출은 0 이다(§4-2). ⛔ 예약은 걸지 않는다(045 ⓑ 결정) · ⛔ 중복 요청·BOM 밖
 * 품목을 막지 않는다(`W-02-10` §8 #4 · §5-3).
 */
@Injectable()
export class MaterialIssueRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  async create(
    input: MaterialIssueRequestCreate,
    appUserId: number,
  ): Promise<MaterialIssueRequestDetail> {
    const { plantId, responsibleWorkerId } = await this.assertCreatable(input);
    // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 안에서 부르면 한 요청이 커넥션을 둘 쥐어
    //    풀 고갈 시 `P2024` 로 죽는다(I-2 R-2 · `release-plan.ts:78-86`). 결번은 허용한다.
    //    기간 축은 클라이언트가 준 `businessDate` 그대로다(공유계약 C-8 · CLAUDE.md).
    const no = await this.numbering.next('MATERIAL_ISSUE_REQUEST', plantId, input.businessDate);
    const picking = await planPicking(this.prisma, this.numbering, {
      plantId,
      demands: input.lines.map((line, index) => ({
        lineNo: index + 1,
        itemId: BigInt(line.itemId),
        uomId: BigInt(line.uomId),
        qty: new Prisma.Decimal(line.requestedQty),
      })),
      periodDate: input.businessDate,
      assignedWorkerId: responsibleWorkerId,
    });
    return this.prisma.$transaction((tx) => this.write(tx, input, no, picking, appUserId));
  }

  /** 헤더 → 라인 → 같은 트랜잭션에서 되읽기(§4-1 ②③④ · 상세 매퍼는 PR ② 것 그대로다). */
  private async write(
    tx: Prisma.TransactionClient,
    input: MaterialIssueRequestCreate,
    issueRequestNo: string,
    picking: PickingPlan,
    appUserId: number,
  ): Promise<MaterialIssueRequestDetail> {
    const header = await tx.material_issue_request.create({
      data: {
        issue_request_no: issueRequestNo,
        work_order_id: input.workOrderId,
        destination_location_id: input.destinationLocationId,
        required_at: input.requiredAt == null ? null : new Date(input.requiredAt),
        status_code: ISSUE_REQUEST_REGISTERED,
        // 주체는 세션 계정이다 — 자동 발행(`work-order-release.service.ts:111`)과 같은 축이라야
        // 같은 표에 주체가 반쪽만 남지 않는다(R-12).
        requested_by: appUserId,
        reason_code: input.reasonCode ?? null,
        remarks: input.remarks ?? null,
        created_by: appUserId,
      },
    });
    // ⛔ `businessDate`·`occurredAt` 을 «안 담는다» — 담을 칸이 없고 이 전표는 원장을 안 지난다.
    await tx.material_issue_request_line.createMany({
      data: input.lines.map((line, index) => ({
        material_issue_request_id: header.material_issue_request_id,
        // 서버가 부여한다 — 본문 순서 그대로 1..M 이다.
        line_no: index + 1,
        bom_component_id: line.bomComponentId ?? null,
        item_id: line.itemId,
        requested_qty: line.requestedQty,
        // ⛔ `issued_qty` 는 기본값 0 그대로다 — 올리는 오퍼레이션이 계약에 0건이다(046).
        uom_id: line.uomId,
        created_by: appUserId,
      })),
    });
    await writePicking(
      tx,
      picking,
      { materialIssueRequestId: header.material_issue_request_id, issueRequestNo },
      appUserId,
    );
    const lines = await tx.material_issue_request_line.findMany({
      where: { material_issue_request_id: header.material_issue_request_id },
      orderBy: { line_no: 'asc' },
    });
    return {
      materialIssueRequest: materialIssueRequestView(header),
      lines: lines.map(materialIssueRequestLineView),
    };
  }

  /**
   * 트랜잭션 «밖»의 검증(§4-4)이고 돌려주는 것은 **W/O 의 공장**이다 — `work_order` 에
   * `plant_id` 가 없어 `production_plan.production_order.plant_id` 로 푼다(I-6 R-7 의 단일 축).
   * ⛔ 없는 id 를 넘기면 FK 위반이 500 으로 샌다 — 밖의 읽기라 FK 가 최종 방어다
   *    (`goods-issue-rules.ts:10-12` 와 같은 규약).
   */
  private async assertCreatable(
    input: MaterialIssueRequestCreate,
  ): Promise<{ plantId: bigint; responsibleWorkerId: bigint | null }> {
    const errors: ErrorItem[] = [];
    // 계약이 `minItems: 1` 을 걸었으나 서비스가 스스로 선다(가드 밖에서 부르는 자리가 생겨도).
    if (input.lines.length === 0) errors.push(field('lines', ERROR_CODE.LINE_REQUIRED, '요청 라인이 1건 이상이어야 합니다.'));
    for (const [index, line] of input.lines.entries()) {
      // 물리 CHECK 를 앞당긴다 — CHECK 위반은 공용 그물에 안 걸려 500 으로 샌다.
      if (!(line.requestedQty > 0)) errors.push(field(`lines[${index}].requestedQty`, ERROR_CODE.RANGE, '요청 수량은 0 보다 커야 합니다.'));
    }
    assertMoments(input, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    // FK 그물 — 축마다 한 번씩 `IN` 으로 모아 읽는다(라인 수와 무관하게 왕복 5회다).
    const ids = (of: (l: MaterialIssueRequestCreateLine) => number | null | undefined): number[] =>
      [...new Set(input.lines.map(of).filter((id): id is number => id != null))];
    const [workOrder, locations, items, uoms, components] = await Promise.all([
      this.prisma.work_order.findUnique({
        where: { work_order_id: input.workOrderId },
        select: {
          status_code: true,
          responsible_worker_id: true,
          production_plan: { select: { production_order: { select: { plant_id: true } } } },
        },
      }),
      this.prisma.location.count({ where: { location_id: input.destinationLocationId } }),
      this.prisma.item.findMany({ where: { item_id: { in: ids((l) => l.itemId) } }, select: { item_id: true } }),
      this.prisma.uom.findMany({ where: { uom_id: { in: ids((l) => l.uomId) } }, select: { uom_id: true } }),
      this.prisma.bom_component.findMany({
        where: { bom_component_id: { in: ids((l) => l.bomComponentId) } },
        select: { bom_component_id: true },
      }),
    ]);

    // ⛔ 404 가 아니라 400 `INVALID` 다 — 계약이 이 경로에 404 를 선언하지 않았다(R-16 ⓒ).
    if (workOrder === null) {
      errors.push(field('workOrderId', ERROR_CODE.INVALID, '없는 작업지시입니다.'));
    } else if (STATE_LOCKED.has(workOrder.status_code)) {
      // 취소·마감된 W/O 에 새 요청을 막는다. 이미 발행된 요청은 건드리지 않는다 — 038 이
      // 답하면 뒤쪽을 연다(I-8.md §4-5).
      errors.push(field('workOrderId', ERROR_CODE.STATE_LOCKED, '취소·마감된 작업지시입니다.'));
    }
    if (locations === 0) errors.push(field('destinationLocationId', ERROR_CODE.INVALID, '없는 위치입니다.'));
    const itemIds = new Set(items.map((row) => Number(row.item_id)));
    const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));
    const componentIds = new Set(components.map((row) => Number(row.bom_component_id)));
    for (const [index, line] of input.lines.entries()) {
      const at = `lines[${index}]`;
      if (!itemIds.has(line.itemId)) errors.push(field(`${at}.itemId`, ERROR_CODE.INVALID, '없는 품목입니다.'));
      if (!uomIds.has(line.uomId)) errors.push(field(`${at}.uomId`, ERROR_CODE.INVALID, '없는 단위입니다.'));
      if (line.bomComponentId != null && !componentIds.has(line.bomComponentId)) {
        errors.push(field(`${at}.bomComponentId`, ERROR_CODE.INVALID, '없는 BOM 구성입니다.'));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    // ⛔ `reasonCode` 를 필수로 만들지 않는다 — 계약이 nullable 이고 `W-02-10` §6 이 「사유
    //    미선택은 화면이 막는다 — DB 는 안 막는다」로 적었다. 값이 오면 목록을 본다(§4-4).
    await assertCodeValues(this.prisma, [
      { field: 'reasonCode', value: input.reasonCode, groupCode: 'MATERIAL_ISSUE_REQUEST_REASON' },
    ]);
    const plantId = workOrder?.production_plan?.production_order.plant_id;
    // I-6 R-6 이 계획 없는 배포를 막았으나 그 전에 생긴 W/O 가 남아 있을 수 있다.
    if (plantId == null) throw one(field('workOrderId', ERROR_CODE.INVALID, '공장을 풀 계획이 없습니다(문의 040).'));
    return { plantId, responsibleWorkerId: workOrder?.responsible_worker_id ?? null };
  }
}

/**
 * 시각의 «형식»만 본다. ⛔ 정규식만으로는 `2026-13-39` 가 통과한다 — 저장은 안 되지만 채번의
 * 기간 축으로 들어가 `MIR-20261339-0001` 이 전표 번호에 영구히 남는다
 * (`goods-issue-rules.ts:105-125` 글자 그대로). 셋 중 `requiredAt` 만 담을 칸이 있다. */
function assertMoments(input: MaterialIssueRequestCreate, errors: ErrorItem[]): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
    Number.isNaN(Date.parse(`${input.businessDate}T00:00:00Z`))
  ) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'));
  }
  for (const name of ['occurredAt', 'requiredAt'] as const) {
    const value = input[name];
    if (value != null && Number.isNaN(Date.parse(value))) errors.push(field(name, ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
}
