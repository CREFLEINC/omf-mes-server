import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveDestinationLocation } from '../destination-location';
import { assertQty } from '../shipment/shipment-rules';
import {
  ReinstatementTarget,
  StockReinstatementCreate,
  StockReinstatementView,
  postStockReinstatement,
} from './stock-reinstatement-posting';

export type { StockReinstatementCreate, StockReinstatementView } from './stock-reinstatement-posting';

const HOLD_RELEASE_REASON_GROUP = 'LOT_HOLD_RELEASE_REASON';
const NUMBER_RETRY = 3;

/**
 * 재고 재등록(`POST /logistics/stock-reinstatements` · 화면 `W-04-11`). 트랜잭션 본체는
 * `stock-reinstatement-posting.ts` 다 — 여기는 트랜잭션 «밖»의 셋(본문 가드 · 코드값 · 도착 위치)과 채번이다.
 */
@Injectable()
export class StockReinstatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly holds: LotHoldService,
    private readonly lots: LotQualityStatusService,
  ) {}

  async create(body: StockReinstatementCreate, appUserId: number): Promise<StockReinstatementView> {
    // ⛔ 본문만 보고 거를 수 있는 것은 DB 왕복 «전»이다 — numeric(20,6) 두 벽(R-12 · 초안은 이 경로 0건).
    assertQty('qty', body.qty);
    await assertCodeValues(this.prisma, [
      { field: 'releaseReasonCode', value: body.releaseReasonCode, groupCode: HOLD_RELEASE_REASON_GROUP },
    ]);
    const target = await this.resolveTarget(body);
    for (let attempt = 1; ; attempt += 1) {
      try {
        // ⭐ 채번은 트랜잭션 «밖»이다. 공장 축은 도착 창고다 — 출발(불량) 창고는 잠금 안에서야 정해진다.
        const transferNo = await this.numbering.next('STOCK_TRANSFER', target.plantId, body.businessDate);
        return await this.prisma.$transaction((tx) =>
          postStockReinstatement(
            tx,
            { posting: this.posting, holds: this.holds, lots: this.lots },
            { body, target, transferNo, appUserId },
          ),
        );
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '재등록 이동 번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  /** 도착 창고 · 위치 — 마스터라 트랜잭션 밖에서 푼다. ⛔ 불량창고로 «되돌리지» 않는다. */
  private async resolveTarget(body: StockReinstatementCreate): Promise<ReinstatementTarget> {
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { warehouse_id: BigInt(body.toWarehouseId), is_active: true },
      select: { plant_id: true, business_unit_id: true, management_level_code: true, is_defect: true },
    });
    if (warehouse === null) throw badRequest('toWarehouseId', ERROR_CODE.INVALID, '쓸 수 있는 창고가 아닙니다.');
    if (warehouse.is_defect) {
      throw badRequest('toWarehouseId', ERROR_CODE.INVALID, '불량창고로는 재등록할 수 없습니다 — 판매 가능 재고로 되돌리는 경로입니다.');
    }
    const locationId = await resolveDestinationLocation(this.prisma, {
      warehouseId: body.toWarehouseId,
      managementLevelCode: warehouse.management_level_code,
      requestedLocationId: body.toLocationId,
      warehouseField: 'toWarehouseId',
      locationField: 'toLocationId',
    });
    return { warehouseId: body.toWarehouseId, plantId: warehouse.plant_id, businessUnitId: warehouse.business_unit_id, locationId };
  }
}

const badRequest = (path: string, code: string, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [field(path, code, message)]);

/** `uq` 위반이 «번호» 때문인가 — 이동 번호와, 원장이 그 번호를 그대로 쓰는 `transaction_no`. */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  const columns = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return columns.some((column) => ['stock_transfer_no', 'transaction_no'].some((name) => column.includes(name)));
}
