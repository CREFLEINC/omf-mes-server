import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ShippingUnitQueryService } from './shipping-unit-query.service';
import { ShippingUnitDetailView, SHIPPING_UNIT_OPEN } from './shipping-unit-view';

/** 채번 키 — 접두어 `SU`. 이 번호가 납품 라벨 번호로 그대로 쓰인다. */
const SHIPPING_UNIT_DOCUMENT_TYPE = 'SHIPPING_UNIT';
/** 유형 값 목록을 가진 코드 그룹(고객이 늘린다). */
const TYPE_CODE_GROUP = 'SHIPPING_UNIT_TYPE';
/** 취소된 출하에는 단위를 열지 않는다. 확정 여부는 묻지 않는다 — 확정과 무관한 작업이다. */
const SHIPMENT_CANCELLED = 'CANCELLED';

export interface ShippingUnitCreate {
  shipmentId: number;
  shippingUnitTypeCode: string;
}

export interface ShippingUnitActor {
  /** 세션 호출에만 있다 — 단말 호출은 작업자로 오고 `created_by` 가 null 이 된다. */
  appUserId?: number;
  plantId?: bigint;
}

@Injectable()
export class ShippingUnitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly queries: ShippingUnitQueryService,
  ) {}

  async create(input: ShippingUnitCreate, actor: ShippingUnitActor): Promise<ShippingUnitDetailView> {
    const shipment = await this.assertCreatable(input, actor);

    // ⛔⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 한 요청이 커넥션을 둘 쥐고,
    //    동시 요청이 풀에 이르면 서로를 기다려 `P2024` 로 죽는다(편성·취급 단위와 같은 규약).
    //    결번은 허용한다(I-2 R-2).
    // ⚠ 기간 축은 서버 UTC 오늘이다 — 취급 단위(`HU-`)와 같은 축이어야 두 번호가 같은 날
    //   같은 조각을 갖는다. 이 전표에는 클라이언트가 주는 업무일자가 없다.
    const no = await this.numbering.next(
      SHIPPING_UNIT_DOCUMENT_TYPE,
      null,
      new Date().toISOString().slice(0, 10),
    );

    const created = await this.prisma.shipping_unit.create({
      data: {
        shipping_unit_no: no,
        shipment_id: shipment.shipment_id,
        shipping_unit_type_code: input.shippingUnitTypeCode,
        status_code: SHIPPING_UNIT_OPEN,
        created_by: actor.appUserId == null ? null : BigInt(actor.appUserId),
      },
      select: { shipping_unit_id: true },
    });
    return this.queries.get(Number(created.shipping_unit_id), actor.plantId);
  }

  /**
   * 트랜잭션 «밖»의 손검사. 둘 다 400 으로 거절하는 성격이라 트랜잭션을 열 이유가 없다.
   *
   * ⛔ 단말 호출이면 그 단말의 공장으로 출하를 좁혀 찾는다 — 못 찾으면 404 다. 「남의 공장
   * 출하가 있다」와 「없다」를 응답으로 가르지 않는다.
   */
  private async assertCreatable(
    input: ShippingUnitCreate,
    actor: ShippingUnitActor,
  ): Promise<{ shipment_id: bigint }> {
    const shipment = await this.prisma.shipment.findFirst({
      where: {
        shipment_id: BigInt(input.shipmentId),
        ...(actor.plantId === undefined ? {} : { warehouse: { plant_id: actor.plantId } }),
      },
      select: { shipment_id: true, status_code: true },
    });
    if (shipment === null) throw new NotFoundException('없는 출하입니다.');
    if (shipment.status_code === SHIPMENT_CANCELLED) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('shipmentId', ERROR_CODE.STATE_LOCKED, '취소된 출하에는 출하 단위를 열 수 없습니다.'),
      ]);
    }

    // ⛔ 유형은 하드코딩하지 않고 코드값을 조회한다 — 고객이 늘리는 그룹이다(G-31).
    const type = await this.prisma.code_value.findFirst({
      where: {
        code: input.shippingUnitTypeCode,
        is_active: true,
        code_group: { group_code: TYPE_CODE_GROUP },
      },
      select: { code_value_id: true },
    });
    if (type === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('shippingUnitTypeCode', ERROR_CODE.INVALID, '없는 출하 단위 유형입니다.'),
      ]);
    }
    return shipment;
  }
}
