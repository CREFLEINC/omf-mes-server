import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `ProductionOrderCreate`(P-30 선행) — 형식·필수·길이는 계약 가드가 이미 막았다. */
export interface ProductionOrderCreate {
  productionOrderNo: string;
  erpOrderNo?: string;
  plantId: number;
  itemId: number;
  orderQty: number;
  uomId?: number;
  dueDate?: string;
  remarks?: string;
}

/** ERP 가 처음 보낸 것과 같은 상태 — 계획·W/O 전개가 이 값에서 시작한다. */
const RECEIVED = 'RECEIVED';
const DUPLICATE_KEY = 'DUPLICATE_KEY';

/**
 * `POST /planning/production-orders` — ERP 수신기가 없어 테스트용으로 P/O 를 직접 넣는다(P-30).
 * ⛔ 수신기 몫(`production_order_change_field`·`last_change_received_at`·확인 행)은 건드리지 않는다 —
 *    «처음 받은» P/O 라 변경 이력이 없다.
 */
@Injectable()
export class ProductionOrderCreateService {
  constructor(private readonly prisma: PrismaService) {}

  async create(body: ProductionOrderCreate, appUserId: number | undefined): Promise<number> {
    const [plant, item, uom, duplicate] = await Promise.all([
      this.prisma.plant.findUnique({
        where: { plant_id: BigInt(body.plantId) },
        select: { is_active: true, business_unit_id: true },
      }),
      this.prisma.item.findUnique({
        where: { item_id: BigInt(body.itemId) },
        select: { is_active: true, base_uom_id: true },
      }),
      body.uomId === undefined
        ? Promise.resolve(undefined)
        : this.prisma.uom.findUnique({ where: { uom_id: BigInt(body.uomId) }, select: { is_active: true } }),
      this.prisma.production_order.findUnique({
        where: { production_order_no: body.productionOrderNo },
        select: { production_order_id: true },
      }),
    ]);

    const businessUnitId = plant?.is_active === true ? plant.business_unit_id : null;
    const uomId = body.uomId === undefined ? item?.base_uom_id : BigInt(body.uomId);
    const errors: ErrorItem[] = [];
    if (plant === null || !plant.is_active) errors.push(field('plantId', ERROR_CODE.INVALID, '없거나 사용 중지된 공장입니다.'));
    // `production_order.business_unit_id` 가 NOT NULL 이다 — 공장이 사업부를 모르면 채울 값이 없다.
    else if (businessUnitId === null) errors.push(field('plantId', ERROR_CODE.INVALID, '사업부가 지정되지 않은 공장입니다.'));
    if (item === null || !item.is_active) errors.push(field('itemId', ERROR_CODE.INVALID, '없거나 사용 중지된 품목입니다.'));
    if (uom === null || uom?.is_active === false) errors.push(field('uomId', ERROR_CODE.INVALID, '없거나 사용 중지된 단위입니다.'));
    if (errors.length > 0 || businessUnitId === null || uomId === undefined) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    if (duplicate !== null) throw duplicateNo();

    try {
      const created = await this.prisma.production_order.create({
        data: {
          production_order_no: body.productionOrderNo,
          erp_order_no: body.erpOrderNo ?? null,
          business_unit_id: businessUnitId,
          plant_id: BigInt(body.plantId),
          item_id: BigInt(body.itemId),
          order_qty: body.orderQty,
          uom_id: uomId,
          due_date: body.dueDate === undefined ? null : new Date(`${body.dueDate}T00:00:00.000Z`),
          status_code: RECEIVED,
          remarks: body.remarks ?? null,
          created_by: appUserId ?? null,
          updated_by: appUserId ?? null,
        },
        select: { production_order_id: true },
      });
      return Number(created.production_order_id);
    } catch (error) {
      // 선조회와 INSERT 사이에 같은 번호가 먼저 들어온 경합.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw duplicateNo();
      throw error;
    }
  }
}

function duplicateNo(): ConflictException {
  return new ConflictException('user', '같은 생산오더 번호가 이미 있습니다.', { code: DUPLICATE_KEY });
}
