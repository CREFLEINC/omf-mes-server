import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryAdjustmentQueryService } from './inventory-adjustment-query.service';
import {
  InventoryAdjustmentCreate,
  LineDimension,
  REGISTERED,
  assertCreatable,
} from './inventory-adjustment-rules';
import { InventoryAdjustmentDetail } from './inventory-adjustment-view';

/**
 * 재고 조정 쓰기. 지금은 «등록» 하나다 — 치환·상신은 PR ③, `:post` 원장은 PR ④ 가 얹는다.
 * ⛔ 등록은 재고를 «안 움직인다» — 잔액을 읽기만 하고 언제나 `REGISTERED` 로 끝난다
 * (계약 `InventoryAdjustmentCreate` 4칸에 `postImmediately` 가 0건이다).
 */

/** 채번이 부딪히는 것은 사용자가 고칠 수 없는 값이라 다시 뽑는다(출고·이동과 같은 판정). */
const NUMBER_RETRY = 3;

@Injectable()
export class InventoryAdjustmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: InventoryAdjustmentQueryService,
    private readonly numbering: NumberingService,
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

/** `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다. */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.some((column) => String(column) === 'inventory_adjustment_no');
}
