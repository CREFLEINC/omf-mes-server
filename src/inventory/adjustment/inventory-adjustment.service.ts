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
import { postAdjustment } from './adjustment-posting';
import { InventoryAdjustmentQueryService } from './inventory-adjustment-query.service';
import {
  APPROVAL_TYPE,
  InventoryAdjustmentCreate,
  LineDimension,
  REGISTERED,
  TARGET_TYPE,
  assertCreatable,
} from './inventory-adjustment-rules';
import { InventoryAdjustmentDetail, InventoryAdjustmentView, inventoryAdjustmentView } from './inventory-adjustment-view';

/**
 * 재고 조정 쓰기 — 등록과 `:post` 전기. 치환·상신은 `InventoryAdjustmentUpdateService` 다.
 * ⛔ 등록은 재고를 «안 움직인다» — 잔액을 읽기만 하고 언제나 `REGISTERED` 로 끝난다
 * (계약 `InventoryAdjustmentCreate` 4칸에 `postImmediately` 가 0건이다).
 */

/** 계약 `PostRequest` — required 2. 서버가 도출하지 않는다(C-8 · C-1). */
export interface PostAdjustmentRequest {
  businessDate: string;
  occurredAt: string;
}

/** 채번이 부딪히는 것은 사용자가 고칠 수 없는 값이라 다시 뽑는다(출고·이동과 같은 판정). */
const NUMBER_RETRY = 3;
const STATUS_COLUMN = 'inventory.inventory_adjustment.status_code';
const POST_ACTION = 'document-post';
const POSTED = 'POSTED';
/** 잔액 선잠금이 커밋까지 간다 — 기본 5초를 넘기면 `P2028` 이 500 으로 샌다(I-3 R-4). */
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

@Injectable()
export class InventoryAdjustmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: InventoryAdjustmentQueryService,
    private readonly numbering: NumberingService,
    private readonly posting: InventoryPostingService,
    private readonly approvals: ApprovalService,
    private readonly documentState: DocumentStateService,
  ) {}

  async create(
    input: InventoryAdjustmentCreate,
    appUserId: number,
  ): Promise<{ detail: InventoryAdjustmentDetail; versionNo: number }> {
    const dimensions = await assertCreatable(this.prisma, input);

    for (let attempt = 0; ; attempt += 1) {
      try {
        // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 열린 트랜잭션 안에서 부르면 한
        //    요청이 커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2.md R-2).
        // ⚠ 기간 축은 «서버 UTC 오늘»이다 — 본문에 날짜 칸이 0개다. 하노이(UTC+7)
        //    00:00–07:00 의 등록은 전날 번호를 받는다. 이 표는 `business_date` 를 안 실어
        //    공유계약 C-8 자리가 아니다(결정 — 통보 135).
        const periodDate = new Date().toISOString().slice(0, 10);
        const adjustmentNo = await this.numbering.next('INVENTORY_ADJUSTMENT', null, periodDate);
        const id = await this.prisma.$transaction((tx) =>
          this.write(tx, input, dimensions, adjustmentNo, appUserId),
        );
        return this.queries.get(Number(id));
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '조정번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  /**
   * ⭐ 순서가 불변식이다 — 헤더 `FOR UPDATE` → 버전 → 상태 전이 → 승인 게이트 → 라인 →
   * 조직 축·잔액 잠금·손검사 → 원장 → 되짚기 → 상태 저장(§3-1·§3-9).
   *
   * ⛔ 채번을 안 부른다 — 번호는 등록에서 이미 났고 원장 번호로 그것을 그대로 쓴다.
   * ⛔ 응답에 ETag 를 안 내린다 — 계약이 `:post` 200 에 헤더를 선언하지 않았다. `version_no`
   *    는 올린다(상태를 옮기므로) — 다음 If-Match 는 상세 GET 이 준다(§3-8).
   */
  async post(
    inventoryAdjustmentId: number,
    version: number,
    input: PostAdjustmentRequest,
    appUserId: number,
  ): Promise<InventoryAdjustmentView> {
    // ⚠ 형식 검증이 트랜잭션 «밖»이라 「없는 전표 + 잘못된 businessDate」는 404 가 아니라
    //    400 이다(입고·출고와 같은 형상 — §3-9).
    assertPostRequest(input);
    const occurredAt = new Date(input.occurredAt);

    return this.prisma.$transaction(async (tx) => {
      // ⛔ 헤더를 먼저 «잠근다» — findUnique 로 읽으면 같은 순간의 두 `:post` 가 둘 다
      //    `REGISTERED` 를 보고 잔액을 두 번 움직인다(상태 잠금이 셋째 겹이다).
      const [header] = await tx.$queryRaw<HeaderRow[]>`
        SELECT inventory_adjustment_id, inventory_adjustment_no, status_code, version_no
          FROM inventory.inventory_adjustment
         WHERE inventory_adjustment_id = ${inventoryAdjustmentId}
           FOR UPDATE`;
      if (header === undefined) throw new NotFoundException('없는 재고 조정입니다.');
      // 존재는 위에서 확인했다 — 값이 다르면 그 사이 누가 먼저 저장한 것이다(재로드로 풀린다).
      if (header.version_no !== version) assertUpdated(0);
      // ⛔ `conflictStatus` 는 400 이다 — 409 는 If-Match 저장 충돌 전용이다. 재전기가 여기 걸린다.
      this.documentState.assertTransition(STATUS_COLUMN, POST_ACTION, header.status_code, HttpStatus.BAD_REQUEST);
      // ⭐ 요청이 0건이면 통과한다 — 상신 안 한 조정은 승인 없이 전기된다(화면 §5-5 호퍼 실측).
      await this.approvals.assertApproved(tx, TARGET_TYPE, header.inventory_adjustment_id, APPROVAL_TYPE);

      const lines = await tx.inventory_adjustment_line.findMany({
        where: { inventory_adjustment_id: header.inventory_adjustment_id },
        orderBy: { line_no: 'asc' },
        select: {
          inventory_adjustment_line_id: true,
          location_id: true,
          item_id: true,
          lot_id: true,
          adjustment_qty: true,
          uom_id: true,
          quality_status_code: true,
          inventory_status_code: true,
        },
      });
      // 라인 0건은 잠금·손검사 0건으로 지나 빈 원장을 세운다 — 등록·치환이 막지만 여기서도 막는다.
      if (lines.length === 0) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          field('lines', ERROR_CODE.LINE_REQUIRED, '조정 라인이 1건 이상이어야 합니다.'),
        ]);
      }
      await postAdjustment(
        tx,
        this.posting,
        {
          inventoryAdjustmentId: header.inventory_adjustment_id,
          inventoryAdjustmentNo: header.inventory_adjustment_no,
          lines: lines.map((line) => ({
            inventoryAdjustmentLineId: line.inventory_adjustment_line_id,
            locationId: line.location_id,
            itemId: line.item_id,
            lotId: line.lot_id,
            adjustmentQty: line.adjustment_qty,
            uomId: line.uom_id,
            qualityStatusCode: line.quality_status_code,
            inventoryStatusCode: line.inventory_status_code,
          })),
          businessDate: input.businessDate,
          occurredAt,
        },
        appUserId,
      );

      const moved = await tx.inventory_adjustment.updateMany({
        where: { inventory_adjustment_id: header.inventory_adjustment_id, version_no: version },
        // ⛔ `adjusted_at` 은 본문 `occurredAt` 이다 — 서버 `now()` 를 지어 넣지 않는다(C-1).
        data: { status_code: POSTED, adjusted_at: occurredAt, version_no: { increment: 1 }, updated_by: appUserId },
      });
      assertUpdated(moved.count);
      // ⭐ 200 은 상세가 아니라 **헤더 하나**다(계약 응답 스키마 `InventoryAdjustment`).
      const row = await tx.inventory_adjustment.findUniqueOrThrow({
        where: { inventory_adjustment_id: header.inventory_adjustment_id },
      });
      return inventoryAdjustmentView(row);
    }, TRANSACTION_OPTIONS);
  }

  /** 헤더 → 라인 N. 한 트랜잭션이다. */
  private async write(
    tx: Prisma.TransactionClient,
    input: InventoryAdjustmentCreate,
    dimensions: LineDimension[],
    adjustmentNo: string,
    appUserId: number,
  ): Promise<bigint> {
    const header = await tx.inventory_adjustment.create({
      data: {
        inventory_adjustment_no: adjustmentNo,
        inventory_count_id: input.inventoryCountId ?? null,
        reason_code: input.reasonCode,
        status_code: REGISTERED,
        created_by: appUserId,
        updated_by: appUserId,
        inventory_adjustment_line: {
          create: input.lines.map((line, index) => ({
            // 계약 「서버가 부여하며 화면이 정하지 않는다」 — 요청 순서대로 1..N 이다.
            line_no: index + 1,
            location_id: line.locationId,
            item_id: line.itemId,
            lot_id: line.lotId ?? null,
            // 잔액 행에서 읽은 값이다 — 지어내지 않는다(결정 — 통보 130).
            quality_status_code: dimensions[index].qualityStatusCode,
            inventory_status_code: dimensions[index].inventoryStatusCode,
            adjustment_qty: line.adjustmentQty,
            uom_id: line.uomId,
            // 계약이 널을 허용하고 물리가 막는다. 계약 원문 「헤더와 «같은 축»이다」를
            // 이행한다 — 안 보낸 라인은 헤더 사유를 물려받는다(§5-3).
            reason_code: line.reasonCode ?? input.reasonCode,
            inventory_count_line_id: line.inventoryCountLineId ?? null,
            created_by: appUserId,
          })),
        },
      },
      select: { inventory_adjustment_id: true },
    });
    // ⛔ `sendToErp` 를 «안 담는다» — 칸이 없다. `erpMessageQueued` 는 늘 거짓이다(§1-4).
    return header.inventory_adjustment_id;
  }
}

interface HeaderRow {
  inventory_adjustment_id: bigint;
  inventory_adjustment_no: string;
  status_code: string;
  version_no: number;
}

/** 형식 검증은 트랜잭션 «밖»이다 — 입고 `goods-receipt.service.ts:156-161` 선례. */
function assertPostRequest(input: PostAdjustmentRequest): void {
  const errors: ErrorItem[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) || Number.isNaN(Date.parse(input.businessDate))) {
    errors.push(field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식입니다.'));
  }
  if (Number.isNaN(Date.parse(input.occurredAt))) {
    errors.push(field('occurredAt', ERROR_CODE.INVALID, '시각 형식이 아닙니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다. */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.some((column) => String(column) === 'inventory_adjustment_no');
}
