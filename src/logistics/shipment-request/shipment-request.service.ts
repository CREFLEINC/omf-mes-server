import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { SessionScope } from '../../auth/session.types';
import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertCodeValues, day } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { prepareOqcRequests, writeOqcRequests } from './shipment-oqc-request';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestView } from './shipment-request-view';
import {
  CUSTOMER_LOT_REQUIREMENT_MAX,
  SHIPMENT_REQUEST_DOCUMENT_TYPE,
  SHIPMENT_REQUEST_REGISTERED,
  SHIPMENT_TIME_SLOT_GROUP,
} from './shipment-request.constants';

/** 계약 `ShipmentRequestLineCreate` — required 5 · 프로퍼티 8. */
export interface ShipmentRequestLineCreate {
  salesOrderLineId?: number | null;
  itemId: number;
  requestedQty: number;
  allocatedQty: number;
  uomId: number;
  customerLotRequirement?: string | null;
  shippingInspectionRequired: boolean;
  minimumRemainingShelfLifeDays?: number | null;
}

/** 계약 `ShipmentRequestCreate` — required 4 · 프로퍼티 6. */
export interface ShipmentRequestCreate {
  salesOrderId?: number | null;
  fulfillmentPlantId?: number | null;
  customerId: number;
  shipToPartnerId: number;
  requestedShipDate: string;
  timeSlotCode?: string | null;
  lines: ShipmentRequestLineCreate[];
}

/** 기존 미배정 요청에 공장을 지정하는 좁은 갱신 본문이다. */
export interface ShipmentRequestUpdate {
  fulfillmentPlantId: number;
}

export interface ShipmentRequestActor {
  appUserId: number;
  scopes: readonly SessionScope[];
}

/**
 * 출하작업지시 편성 — `W-04-01` 의 「편성」과 「단독 생성」이 **한 경로**다(계약 description).
 * `salesOrderId` 를 비우면 단독 생성이고, 그것이 예외가 아니라 상시 구조다(`W-04-01` §5-2).
 *
 * ⛔ 편성 취소를 두지 않는다 — 계약에 그 오퍼레이션이 0건이다.
 * ⛔ 예약을 걸지 않는다 — 예약은 `:pick`(PR ⑥)이 건다. 그래서 갓 편성된 건의 `pickedQty` 는
 *    전부 0 이고, 배정이 늘 0 보다 커 **`NOT_ALLOCATED` 는 편성으로 만들 수 없다**(e2e W-21).
 */
@Injectable()
export class ShipmentRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly queries: ShipmentRequestQueryService,
  ) {}

  async create(input: ShipmentRequestCreate, actor: ShipmentRequestActor): Promise<ShipmentRequestView> {
    await this.assertCreatable(input, actor);
    // ⛔⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 한 요청이 커넥션을 둘 쥐고,
    //    동시 요청이 풀에 이르면 서로를 기다려 `P2024` 로 죽는다(`numbering.service.ts:87-89`).
    //    결번은 허용한다(I-2 R-2). ⛔ 기간 축은 «클라이언트가 준» `requestedShipDate` 다 —
    //    서버가 「오늘」로 다시 잡으면 자정을 넘긴 재전송이 다른 날 번호를 받는다(공유계약 C-8).
    const no = await this.numbering.next(
      SHIPMENT_REQUEST_DOCUMENT_TYPE,
      null,
      input.requestedShipDate,
    );
    // ⭐ 출하검사(OQC) 의뢰도 편성이 만든다 — 계약이 「서버가 입하·실적·«출하» 시점에
    //   REQUESTED 로 만든다」고 적었는데 입하만 구현돼 있었다(PQC 는 아직 공백이다).
    //   ⛔ 채번·기준 조회를 «여기서» 끝낸다 — 트랜잭션 안에서 부르면 커넥션을 둘 쥔다.
    const oqc = await prepareOqcRequests(
      this.prisma,
      this.numbering,
      input.lines,
      input.requestedShipDate,
    );
    const requestedAt = new Date();
    const shipmentRequestId = await this.prisma.$transaction(async (tx) => {
      const id = await this.write(tx, input, no, actor.appUserId);
      await writeOqcRequests(tx, id, oqc, actor.appUserId, requestedAt);
      return id;
    });
    // ⭐ 201 본문은 ③b 의 상세 뷰 **그대로**다 — 파생 축 둘(진행·검사)을 여기서 다시 판정하면
    //   같은 건이 편성 직후와 재조회에서 다르게 보인다.
    return this.queries.get(Number(shipmentRequestId));
  }

  /**
   * 구버전이 만든 미배정 요청을 이행 공장에 연결한다. 피킹이 시작된 요청은 소유를 옮기지
   * 않고, 이미 출하가 있으면 그 출하 창고가 모두 같은 공장인지 확인한다.
   */
  async updateFulfillmentPlant(
    shipmentRequestId: number,
    expectedVersion: number,
    input: ShipmentRequestUpdate,
    actor: ShipmentRequestActor,
  ): Promise<{ shipmentRequest: ShipmentRequestView; versionNo: number }> {
    await this.assertFulfillmentPlant(input.fulfillmentPlantId, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ shipment_request_id: bigint }[]>`
        SELECT shipment_request_id
          FROM logistics.shipment_request
         WHERE shipment_request_id = ${BigInt(shipmentRequestId)}
         FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundException('없는 출하작업지시입니다.');
      }
      const request = await tx.shipment_request.findUnique({
        where: { shipment_request_id: BigInt(shipmentRequestId) },
        include: {
          shipment: { select: { warehouse: { select: { plant_id: true } } } },
          shipment_request_line: { select: { shipment_request_line_id: true } },
        },
      });
      if (request === null) throw new NotFoundException('없는 출하작업지시입니다.');
      if (request.version_no !== expectedVersion) {
        assertUpdated(0, 'user', {
          code: 'VERSION_CONFLICT',
          currentVersion: String(request.version_no),
        });
      }

      const targetPlantId = BigInt(input.fulfillmentPlantId);
      if (request.fulfillment_plant_id === targetPlantId) {
        return { versionNo: request.version_no };
      }

      const lineIds = request.shipment_request_line.map((line) => line.shipment_request_line_id);
      const picked =
        lineIds.length === 0
          ? null
          : await tx.inventory_reservation.findFirst({
              where: {
                source_document_type_code: 'SHIPMENT_REQUEST_LINE',
                source_document_id: { in: lineIds },
              },
              select: { inventory_reservation_id: true },
            });
      if (picked !== null) {
        throw new ConflictException('user', '피킹이 시작된 출하작업지시는 공장을 바꿀 수 없습니다.', {
          code: 'INVALID_STATE',
        });
      }
      if (request.shipment.some((shipment) => shipment.warehouse.plant_id !== targetPlantId)) {
        throw new ConflictException('user', '기존 출하 창고와 다른 공장을 지정할 수 없습니다.', {
          code: 'INVALID_STATE',
        });
      }

      const updated = await tx.shipment_request.updateMany({
        where: {
          shipment_request_id: request.shipment_request_id,
          version_no: expectedVersion,
        },
        data: {
          fulfillment_plant_id: targetPlantId,
          updated_by: actor.appUserId,
          version_no: { increment: 1 },
        },
      });
      assertUpdated(updated.count, 'user', {
        code: 'VERSION_CONFLICT',
        currentVersion: String(request.version_no),
      });
      return { versionNo: expectedVersion + 1 };
    });
    const shipmentRequest = await this.queries.get(shipmentRequestId);
    return { shipmentRequest, versionNo: result.versionNo };
  }

  /** 헤더 → 라인. ⛔ 되읽기는 트랜잭션 «밖»이다 — ③b 의 질의가 `PrismaService` 로 돈다. */
  private async write(
    tx: Prisma.TransactionClient,
    input: ShipmentRequestCreate,
    shipmentRequestNo: string,
    appUserId: number,
  ): Promise<bigint> {
    const header = await tx.shipment_request.create({
      data: {
        shipment_request_no: shipmentRequestNo,
        sales_order_id: input.salesOrderId ?? null,
        fulfillment_plant_id: input.fulfillmentPlantId ?? null,
        customer_id: input.customerId,
        ship_to_partner_id: input.shipToPartnerId,
        requested_ship_date: day('requestedShipDate', input.requestedShipDate),
        ship_time_slot_code: input.timeSlotCode ?? null,
        status_code: SHIPMENT_REQUEST_REGISTERED,
        created_by: appUserId,
      },
    });
    await tx.shipment_request_line.createMany({
      // ⛔ `line_no` 는 서버가 **1부터 본문 배열 순서 그대로** 부여한다 — 계약이 `lineNo` 를
      //    생성 본문에 안 실었다(P/O·입하 선례). 0 부터거나 역순이면 `uq_shipment_request_line`
      //    은 여전히 통과하고 화면의 행 번호만 어긋난다(e2e W-5).
      data: input.lines.map((line, index) => ({
        shipment_request_id: header.shipment_request_id,
        line_no: index + 1,
        sales_order_line_id: line.salesOrderLineId ?? null,
        item_id: line.itemId,
        requested_qty: line.requestedQty,
        allocated_qty: line.allocatedQty,
        // ⛔ `shipped_qty` 는 기본값 0 그대로다 — 올리는 것은 I-23 출하 확정이다.
        uom_id: line.uomId,
        customer_lot_requirement: line.customerLotRequirement ?? null,
        shipping_inspection_required: line.shippingInspectionRequired,
        minimum_remaining_shelf_life_days: line.minimumRemainingShelfLifeDays ?? null,
        created_by: appUserId,
      })),
    });
    return header.shipment_request_id;
  }

  /**
   * 트랜잭션 «밖»의 손검사. 물리 CHECK 를 앞당기는 것이 대부분인데 — CHECK 위반은 공용 그물에
   * 안 걸려 **500** 으로 새기 때문이다 — **`allocatedQty > 0` 하나만은 계약도 물리도 안 막는
   * 순수 서버 규칙**이다(`ck_shipment_request_qty` 는 `shipped ≤ allocated ≤ requested` 만 본다).
   * 근거는 계약 `ShipmentRequestCreate.description` 「라인 1건 이상이고 **배정 수량이 1 이상**이어야
   * 한다(`W-04-01` §5-7)」다. ⇒ e2e W-8 이 그 자리의 **유일한** 그물이다.
   * ⛔ `lines: []` 를 여기서 다시 막지 않는다 — 계약 `minItems: 1` 이 이미 400 을 낸다(I-21 R-15).
   */
  private async assertCreatable(input: ShipmentRequestCreate, actor: ShipmentRequestActor): Promise<void> {
    // ⛔ 순서가 판정이다(§3-4) — 모양이 틀린 본문으로 참조 질의를 쏘지 않는다.
    this.assertShape(input);
    await this.assertReferences(input, actor);
    // 값이 오면 코드 목록을 본다 — `null` 은 통과다(계약이 nullable 이고 「일부 항목」만 채운다).
    await assertCodeValues(this.prisma, [
      { field: 'timeSlotCode', value: input.timeSlotCode, groupCode: SHIPMENT_TIME_SLOT_GROUP },
    ]);
  }

  /** ① 본문 «모양» — 수량 넷과 길이 하나. 질의를 한 번도 안 쏜다. */
  private assertShape(input: ShipmentRequestCreate): void {
    const errors: ErrorItem[] = [];
    for (const [index, line] of input.lines.entries()) {
      const at = `lines[${index}]`;
      if (!(line.requestedQty > 0)) {
        errors.push(field(`${at}.requestedQty`, ERROR_CODE.RANGE, '요청 수량은 0 보다 커야 합니다.'));
      }
      if (!(line.allocatedQty > 0)) {
        errors.push(field(`${at}.allocatedQty`, ERROR_CODE.RANGE, '배정 수량은 0 보다 커야 합니다.'));
      }
      // ⭐ 한계와 «같은» 값은 통과다 — `<` 로 조이면 전량 배정이 막힌다(e2e W-6).
      if (line.allocatedQty > line.requestedQty) {
        errors.push(field(`${at}.allocatedQty`, ERROR_CODE.RANGE, '배정 수량은 요청 수량을 넘을 수 없습니다.'));
      }
      // 계약에 `maxLength` 가 없다 — 물리 `varchar(200)`.
      if ((line.customerLotRequirement?.length ?? 0) > CUSTOMER_LOT_REQUIREMENT_MAX) {
        errors.push(field(`${at}.customerLotRequirement`, ERROR_CODE.RANGE, `고객 LOT 조건은 ${CUSTOMER_LOT_REQUIREMENT_MAX}자 이하입니다.`));
      }
      // ⭐ 물리 CHECK 가 `>= 0` 이다 — **0 은 통과**다(e2e W-18).
      if ((line.minimumRemainingShelfLifeDays ?? 0) < 0) {
        errors.push(field(`${at}.minimumRemainingShelfLifeDays`, ERROR_CODE.RANGE, '잔여 유효기간 하한은 0 이상이어야 합니다.'));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  /** ② 참조 무결 — 존재 넷 + 짝 하나. 축마다 한 번씩 `IN` 으로 모아 읽는다(왕복 5회). */
  private async assertReferences(input: ShipmentRequestCreate, actor: ShipmentRequestActor): Promise<void> {
    const errors: ErrorItem[] = [];
    const ids = (of: (l: ShipmentRequestLineCreate) => number | null | undefined): number[] =>
      [...new Set(input.lines.map(of).filter((id): id is number => id != null))];
    const [salesOrder, partners, items, uoms, salesOrderLines] = await Promise.all([
      input.salesOrderId == null
        ? null
        : this.prisma.sales_order.count({ where: { sales_order_id: input.salesOrderId } }),
      this.prisma.partner.findMany({
        where: { partner_id: { in: [input.customerId, input.shipToPartnerId] } },
        select: { partner_id: true },
      }),
      this.prisma.item.findMany({ where: { item_id: { in: ids((l) => l.itemId) } }, select: { item_id: true } }),
      this.prisma.uom.findMany({ where: { uom_id: { in: ids((l) => l.uomId) } }, select: { uom_id: true } }),
      this.prisma.sales_order_line.findMany({
        where: { sales_order_line_id: { in: ids((l) => l.salesOrderLineId) } },
        select: { sales_order_line_id: true, sales_order_id: true },
      }),
    ]);

    // ⛔ 없는 출하지시서는 **404 가 아니라 400 `INVALID`** 다 — 계약이 이 경로에 404 를
    //    선언하지 않았다(§1-1 · e2e W-11). 404 를 내면 계약 밖 응답이 된다.
    if (salesOrder === 0) errors.push(field('salesOrderId', ERROR_CODE.INVALID, '없는 출하지시서입니다.'));
    const partnerIds = new Set(partners.map((row) => Number(row.partner_id)));
    if (!partnerIds.has(input.customerId)) errors.push(field('customerId', ERROR_CODE.INVALID, '없는 고객입니다.'));
    if (!partnerIds.has(input.shipToPartnerId)) errors.push(field('shipToPartnerId', ERROR_CODE.INVALID, '없는 배송처입니다.'));

    const itemIds = new Set(items.map((row) => Number(row.item_id)));
    const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));
    const owner = new Map(
      salesOrderLines.map((row) => [Number(row.sales_order_line_id), Number(row.sales_order_id)]),
    );
    for (const [index, line] of input.lines.entries()) {
      const at = `lines[${index}]`;
      if (!itemIds.has(line.itemId)) errors.push(field(`${at}.itemId`, ERROR_CODE.INVALID, '없는 품목입니다.'));
      if (!uomIds.has(line.uomId)) errors.push(field(`${at}.uomId`, ERROR_CODE.INVALID, '없는 단위입니다.'));
      // ⭐ 존재가 아니라 **짝**을 본다 — 「그 지시서의 라인인가」. 단독 생성(`salesOrderId` 널)에
      //   지시서 라인을 매달면 그 라인은 어느 지시서에도 안 걸린 채 남는다(e2e W-13).
      if (
        line.salesOrderLineId != null &&
        (input.salesOrderId == null || owner.get(line.salesOrderLineId) !== input.salesOrderId)
      ) {
        errors.push(field(`${at}.salesOrderLineId`, ERROR_CODE.PAIR, '출하지시서의 라인이 아닙니다.'));
      }
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    if (input.fulfillmentPlantId !== undefined && input.fulfillmentPlantId !== null) {
      await this.assertFulfillmentPlant(input.fulfillmentPlantId, actor);
    }
  }

  private async assertFulfillmentPlant(plantId: number, actor: ShipmentRequestActor): Promise<void> {
    if (!Number.isSafeInteger(plantId) || plantId < 1) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('fulfillmentPlantId', ERROR_CODE.RANGE, '이행 공장은 양의 정수여야 합니다.'),
      ]);
    }
    const plant = await this.prisma.plant.findFirst({
      where: { plant_id: BigInt(plantId), is_active: true },
      select: { business_unit_id: true },
    });
    if (plant === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('fulfillmentPlantId', ERROR_CODE.INVALID, '사용 가능한 공장이 아닙니다.'),
      ]);
    }
    const authorized = actor.scopes.some(
      (scope) =>
        scope.plantId === plantId ||
        (scope.plantId === undefined && plant.business_unit_id !== null && scope.businessUnitId === Number(plant.business_unit_id)),
    );
    if (!authorized) {
      throw new ContractException(HttpStatus.FORBIDDEN, [
        field('fulfillmentPlantId', ERROR_CODE.PERMISSION_DENIED, '이 공장에 대한 데이터 권한이 없습니다.'),
      ]);
    }
  }
}
