import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertCodeValues, assertWorkerNoPresent } from '../../common/master';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { LogisticsWriteActor } from '../logistics-write-actor';
import {
  SHOPFLOOR_RECEIPT_INCLUDE,
  ShopfloorReceiptDetail,
  shopfloorReceiptView,
} from './shopfloor-receipt-view';
import { ISSUE_POSTED, RECEIPT_REGISTERED } from './shopfloor-receipt.constants';

/** 계약 `ShopfloorReceiptLineCreate` — required 6 · 선택 `varianceReasonCode`(I-9.md §1-3). */
export interface ShopfloorReceiptCreateLine {
  goodsIssueLineId: number;
  itemId: number;
  lotId: number;
  issuedQty: number;
  receivedQty: number;
  uomId: number;
  varianceReasonCode?: string | null;
}

/** 계약 `ShopfloorReceiptCreate` — required 7 · 선택 0(I-9.md §1-3). */
export interface ShopfloorReceiptCreate {
  goodsIssueId: number;
  workOrderId: number;
  destinationLocationId: number;
  receivedAt: string;
  businessDate: string;
  occurredAt: string;
  lines: ShopfloorReceiptCreateLine[];
}

/** ②에서 읽는 출고 라인 한 행 — `assertLinesAgainstIssue` 의 대조 대상(I-9.md §3-3). */
interface IssueLineRow {
  goods_issue_line_id: bigint;
  item_id: bigint;
  lot_id: bigint;
  uom_id: bigint;
  issue_qty: Prisma.Decimal;
}

/** `CD-LOGISTICS-DOCUMENT-STATUS` 중 취소 계열 둘 — R-9 400 갈래표(I-9.md §3-2 ⓐ). */
const ISSUE_CANCELLED = new Set(['CANCEL_REQUESTED', 'CANCELLED']);

/**
 * 생산창고 입고 등록 — 이 슬라이스의 심장(I-9.md §3). ⛔ 원장을 안 지난다(§3-4 · `plan.md`
 * §0 #13 「기록만」) · ⛔ `transitions.ts` 무변경(§3-5 — 이 전표는 영원히 `REGISTERED`) ·
 * ⛔ 마이그레이션 0(§2-4). 차이는 `variance_qty`(GENERATED) + `variance_reason_code` 로
 * 기록만 하고 재고를 맞추는 것은 I-14 재고 조정의 몫이다.
 */
@Injectable()
export class ShopfloorReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  async create(
    input: ShopfloorReceiptCreate,
    actorOrUser: LogisticsWriteActor | number,
    workerNo: string | undefined,
  ): Promise<ShopfloorReceiptDetail> {
    const actor: LogisticsWriteActor = typeof actorOrUser === 'number' ? { appUserId: actorOrUser } : actorOrUser;
    assertWorkerNoPresent(workerNo);
    const plantId = await this.assertCreatable(input);
    // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 안에서 부르면 한 요청이 커넥션을
    //    둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2 R-2 · `material-issue-request.service.ts:62`
    //    그대로). 결번은 허용한다. 기간 축은 클라이언트가 준 `businessDate` 그대로다(C-8).
    const no = await this.numbering.next('SHOPFLOOR_RECEIPT', plantId, input.businessDate);
    return this.prisma.$transaction((tx) => this.write(tx, input, no, actor));
  }

  /** §3-8 잠금 → INSERT → createMany → 같은 tx 되읽기(§3-1 ⑥~⑩). */
  private async write(
    tx: Prisma.TransactionClient,
    input: ShopfloorReceiptCreate,
    shopfloorReceiptNo: string,
    actor: LogisticsWriteActor,
  ): Promise<ShopfloorReceiptDetail> {
    // 목적은 재고가 아니라 «중복 수령»이다 — UNIQUE(goods_issue_id) 가 없어 행 잠금으로 레이스를 막는다(I-9 §3-8).
    await tx.$queryRaw`SELECT status_code FROM logistics.goods_issue WHERE goods_issue_id = ${input.goodsIssueId} FOR UPDATE`;
    const dup = await tx.shopfloor_receipt.count({ where: { goods_issue_id: input.goodsIssueId } });
    if (dup > 0) throw one(field('goodsIssueId', ERROR_CODE.STATE_LOCKED, '이미 수령한 출고입니다.'));

    const header = await tx.shopfloor_receipt.create({
      data: {
        shopfloor_receipt_no: shopfloorReceiptNo,
        goods_issue_id: input.goodsIssueId,
        work_order_id: input.workOrderId,
        destination_location_id: input.destinationLocationId,
        received_at: new Date(input.receivedAt),
        // 계정 없는 단말은 같은 tx의 worker 감사 이벤트가 실제 행위자를 보존한다.
        received_by: actor.appUserId ?? null,
        status_code: RECEIPT_REGISTERED,
        created_by: actor.appUserId ?? null,
      },
    });
    // `variance_qty` 는 GENERATED STORED 다 — data 에 넣지 않는다(I-9.md §2-2).
    await tx.shopfloor_receipt_line.createMany({
      data: input.lines.map((line) => ({
        shopfloor_receipt_id: header.shopfloor_receipt_id,
        goods_issue_line_id: line.goodsIssueLineId,
        item_id: line.itemId,
        lot_id: line.lotId,
        issued_qty: line.issuedQty,
        received_qty: line.receivedQty,
        uom_id: line.uomId,
        variance_reason_code: line.varianceReasonCode ?? null,
        created_by: actor.appUserId ?? null,
      })),
    });

    if (actor.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
      actor: actor.terminalAudit, targetTypeCode: 'SHOPFLOOR_RECEIPT',
      targetId: header.shopfloor_receipt_id, eventTypeCode: 'CREATE',
    });

    const row = await tx.shopfloor_receipt.findUniqueOrThrow({
      where: { shopfloor_receipt_id: header.shopfloor_receipt_id },
      include: SHOPFLOOR_RECEIPT_INCLUDE,
    });
    const view = shopfloorReceiptView(row);
    // 상세와 같은 모양(§4-3) — 바깥과 `shopfloorReceipt.lines` 둘 다 같은 배열을 싣는다.
    return { shopfloorReceipt: view, lines: view.lines };
  }

  /**
   * 트랜잭션 «밖»의 검증(§3-1 ①~④)이고 돌려주는 것은 **W/O 의 공장**이다 —
   * `work_order` 에 `plant_id` 가 없어 `production_plan.production_order.plant_id` 로
   * 푼다(`material-issue-request.service.ts:150-155` 그대로).
   */
  private async assertCreatable(input: ShopfloorReceiptCreate): Promise<bigint> {
    const errors: ErrorItem[] = [];
    assertLineShape(input, errors);
    assertMoments(input, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    // FK 그물 — 축마다 한 번(§3-1 ②). item/lot/uom 은 출고 라인 대조로 갈음한다(별도 존재
    // 검사 불필요 · 브리프).
    const [issue, workOrder, locationCount] = await Promise.all([
      this.prisma.goods_issue.findUnique({
        where: { goods_issue_id: input.goodsIssueId },
        select: {
          status_code: true,
          goods_issue_line: {
            select: { goods_issue_line_id: true, item_id: true, lot_id: true, uom_id: true, issue_qty: true },
          },
        },
      }),
      this.prisma.work_order.findUnique({
        where: { work_order_id: input.workOrderId },
        select: { production_plan: { select: { production_order: { select: { plant_id: true } } } } },
      }),
      this.prisma.location.count({ where: { location_id: input.destinationLocationId } }),
    ]);

    if (issue === null) {
      // ⛔ 404 가 아니라 400 `INVALID` 다 — 계약이 이 경로에 404 를 선언하지 않았다(§1-1).
      errors.push(field('goodsIssueId', ERROR_CODE.INVALID, '없는 출고입니다.'));
    } else {
      // 없는 출고면 라인 검증은 건너뛴다 — 대조 대상이 없다(R-9 표).
      assertIssueStatus(issue.status_code, errors);
      assertLinesAgainstIssue(input, issue.goods_issue_line, errors);
    }
    if (workOrder === null) errors.push(field('workOrderId', ERROR_CODE.INVALID, '없는 작업지시입니다.'));
    // ⛔ `work_order.status_code` 를 안 본다 — 출고가 이미 전기돼 물건이 떠났다. 취소된
    //    W/O 라도 도착한 실물 기록을 거부하지 않는다(R-8).
    if (locationCount === 0) errors.push(field('destinationLocationId', ERROR_CODE.INVALID, '없는 위치입니다.'));
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(
      this.prisma,
      input.lines.map((line, index) => ({
        field: `lines[${index}].varianceReasonCode`,
        value: line.varianceReasonCode,
        groupCode: 'VARIANCE_REASON',
      })),
    );

    const plantId = workOrder?.production_plan?.production_order.plant_id;
    // I-6 R-6 이 계획 없는 배포를 막았으나 그 전에 생긴 W/O 가 남아 있을 수 있다(문의 040).
    if (plantId == null) throw one(field('workOrderId', ERROR_CODE.INVALID, '공장을 풀 계획이 없습니다(문의 040).'));
    return plantId;
  }
}

/**
 * ①의 몸통 형식 검증 — 라인 1행 이상(계약 `minItems` 부재 실측 · §1-3) · 본문 안 라인
 * 중복 · 수량 범위(물리 CHECK 앞당김 · §2-3) · 차이-사유 짝(§3-3 ⓖ).
 */
function assertLineShape(input: ShopfloorReceiptCreate, errors: ErrorItem[]): void {
  if (input.lines.length === 0) {
    errors.push(field('lines', ERROR_CODE.LINE_REQUIRED, '출고 라인 전건을 실어야 합니다.'));
    return;
  }
  const seen = new Set<number>();
  input.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    if (seen.has(line.goodsIssueLineId)) {
      errors.push(field(`${at}.goodsIssueLineId`, ERROR_CODE.INVALID, '같은 라인이 중복됩니다.'));
    }
    seen.add(line.goodsIssueLineId);

    if (line.issuedQty < 0) errors.push(field(`${at}.issuedQty`, ERROR_CODE.RANGE, '출고 수량은 0 이상이어야 합니다.'));
    if (line.receivedQty < 0) errors.push(field(`${at}.receivedQty`, ERROR_CODE.RANGE, '수령 수량은 0 이상이어야 합니다.'));
    if (line.receivedQty > line.issuedQty) {
      errors.push(field(`${at}.receivedQty`, ERROR_CODE.RANGE, '수령 수량이 출고 수량을 넘었습니다.'));
    }

    const variance = line.issuedQty - line.receivedQty;
    if (variance !== 0 && line.varianceReasonCode == null) {
      errors.push(field(`${at}.varianceReasonCode`, ERROR_CODE.REQUIRED, '차이가 있으면 사유가 필요합니다.'));
    } else if (variance === 0 && line.varianceReasonCode != null) {
      // 계약 미기재 갈래 — 알려둘 것 ⓟ(R-5): 화면은 차이 0 이면 애초에 안 보낸다(§5-6).
      errors.push(field(`${at}.varianceReasonCode`, ERROR_CODE.INVALID, '차이가 없으면 사유를 보낼 수 없습니다.'));
    }
  });
}

/** 형식만 본다 — 저장할 칸이 없다(C-8 · `material-issue-request.service.ts:184-198` 그대로). */
function assertMoments(input: ShopfloorReceiptCreate, errors: ErrorItem[]): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
    Number.isNaN(Date.parse(`${input.businessDate}T00:00:00Z`))
  ) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'));
  }
  for (const name of ['occurredAt', 'receivedAt'] as const) {
    if (Number.isNaN(Date.parse(input[name]))) errors.push(field(name, ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
}

/** R-9 400 갈래표 — 출고 헤더(I-9.md §3-2 ⓐ). `POSTED` 비교는 이 도메인의 `ISSUE_POSTED` 상수. */
function assertIssueStatus(statusCode: string, errors: ErrorItem[]): void {
  if (statusCode === ISSUE_POSTED) return;
  if (ISSUE_CANCELLED.has(statusCode)) {
    errors.push(field('goodsIssueId', ERROR_CODE.STATE_LOCKED, '취소(요청)된 출고입니다.'));
    return;
  }
  errors.push(field('goodsIssueId', ERROR_CODE.STATE_LOCKED, '전기되지 않은 출고입니다.'));
}

/**
 * R-1 전건 규칙 + ⓒⓓⓔ(§3-3) — 본문 `lines` 의 `goodsIssueLineId` 집합이 그 출고의
 * `goods_issue_line` 전건과 같아야 한다. 빠지면 400 `LINE_REQUIRED`, 남의 출고 라인·
 * 품목·LOT·단위 불일치·수량 불일치는 400 `INVALID`.
 */
function assertLinesAgainstIssue(
  input: ShopfloorReceiptCreate,
  actualLines: readonly IssueLineRow[],
  errors: ErrorItem[],
): void {
  const actualById = new Map(actualLines.map((row) => [Number(row.goods_issue_line_id), row]));
  const bodyIds = new Set(input.lines.map((line) => line.goodsIssueLineId));
  const missing = [...actualById.keys()].some((id) => !bodyIds.has(id));
  if (missing) errors.push(field('lines', ERROR_CODE.LINE_REQUIRED, '출고 라인 전건을 실어야 합니다.'));

  input.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    const actual = actualById.get(line.goodsIssueLineId);
    if (actual === undefined) {
      errors.push(field(`${at}.goodsIssueLineId`, ERROR_CODE.INVALID, '이 라인의 출고가 아닙니다.'));
      return;
    }
    if (line.itemId !== Number(actual.item_id)) errors.push(field(`${at}.itemId`, ERROR_CODE.INVALID, '출고 라인과 품목이 다릅니다.'));
    if (line.lotId !== Number(actual.lot_id)) errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '출고 라인과 LOT 이 다릅니다.'));
    if (line.uomId !== Number(actual.uom_id)) errors.push(field(`${at}.uomId`, ERROR_CODE.INVALID, '출고 라인과 단위가 다릅니다.'));
    // 대조이지 덮어쓰기가 아니다 — 설계 미정 — 문의 049(§3-3 ⓔ · R-3·R-6).
    if (line.issuedQty !== Number(actual.issue_qty)) {
      errors.push(field(`${at}.issuedQty`, ERROR_CODE.INVALID, '출고 라인의 수량과 다릅니다.'));
    }
  });
}
