import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MATERIAL_RETURN_LINE_INCLUDE,
  MaterialReturnView,
  materialReturnView,
} from './material-return-view';
import { RETURN_REQUESTED } from './material-return.constants';

/** 계약 `MaterialReturnLine` — 쓰기에 유효한 칸은 넷뿐이다(`materialReturnLineId` 는 응답 칸 · I-10 §1-3). */
export interface MaterialReturnCreateLine {
  itemId: number;
  lotId: number;
  returnQty: number;
  uomId: number;
}

/** 계약 `MaterialReturnCreate` — required 4 · 선택 0(I-10 §1-3). */
export interface MaterialReturnCreate {
  workOrderId: number;
  sourceLocationId: number;
  destinationWarehouseId: number;
  lines: MaterialReturnCreateLine[];
}

/**
 * 자재 반출 등록 — 이 슬라이스의 심장 둘째(I-10 §4).
 *
 * ⛔ **원장을 만들지 않는다**(§4-4 · R-2) — `post()` 가 요구하는 `businessDate`·`occurredAt`·
 *    목적 «위치»·`sourceDocumentTypeCode` 넷 다 계약에 없다. 설계 미정 — 문의 051.
 *    ⇒ `material_return_line.inventory_transaction_line_id` 는 영원히 NULL 이고
 *    `InventoryPostingService` 를 **생성자에서도 받지 않는다**.
 * ⛔ 잔량 대조를 하지 않는다(§4-3 ⓔ) — 「반출량 ≤ 그 위치의 on_hand」를 걸려면 잔액 차원
 *    넷(`quality_status_code`·`inventory_status_code`·`ownership_type_code`·`owner_partner_id`)을
 *    골라야 하는데 계약 라인에 그 칸이 0 이다(I-4 문의 031 과 같은 자리).
 * ⛔ 잠금 0 · 상태 전이 0 · `version_no` 를 안 읽고 안 올린다(§4-6).
 */
@Injectable()
export class MaterialReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  async create(
    input: MaterialReturnCreate,
    appUserId: number,
    workerNo: string | undefined,
  ): Promise<MaterialReturnView> {
    assertWorkerNo(workerNo);
    const plantId = await this.assertCreatable(input);
    // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 안에서 부르면 한 요청이 커넥션을 둘
    //    쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2 R-2). 결번은 허용한다.
    // ⚠ 기간 축이 «서버 시각의 UTC 날짜»다 — 이 계약에 `businessDate` 도 `occurredAt` 도
    //    없어 클라이언트가 준 날짜가 아예 없다(§4-6 · 문의 051).
    const no = await this.numbering.next('MATERIAL_RETURN', plantId, utcDate(new Date()));
    return this.prisma.$transaction((tx) => this.write(tx, input, no, appUserId));
  }

  /** §4-7 ⑥~⑧ — INSERT → createMany(`line_no` 1..N) → 같은 tx 되읽기. */
  private async write(
    tx: Prisma.TransactionClient,
    input: MaterialReturnCreate,
    materialReturnNo: string,
    appUserId: number,
  ): Promise<MaterialReturnView> {
    const header = await tx.material_return.create({
      data: {
        material_return_no: materialReturnNo,
        work_order_id: input.workOrderId,
        source_location_id: input.sourceLocationId,
        destination_warehouse_id: input.destinationWarehouseId,
        status_code: RETURN_REQUESTED,
        // 담을 칸은 있는데 받을 칸이 없다 — C-8 은 원장 3표에만 실린다 · 문의 051.
        requested_at: new Date(),
        // ⛔ `received_at` 을 생략한다 — 채우는 오퍼레이션이 계약에 0건이다(§4-4).
        created_by: appUserId,
      },
    });
    // ⛔ `return_quality_status_code`·`package_opened`·`quality_check_required` 를 넣지 않는다 —
    //    계약 라인에 그 칸이 0 이라 무엇을 기록할지 위임받지 않았다(R-4 · DEFAULT false 그대로).
    await tx.material_return_line.createMany({
      data: input.lines.map((line, index) => ({
        material_return_id: header.material_return_id,
        // 계약 라인에 `lineNo` 가 없다 — 본문 순서로 서버가 1..N 을 매긴다(I-4 `goods_issue_line` 선례).
        line_no: index + 1,
        item_id: line.itemId,
        lot_id: line.lotId,
        return_qty: line.returnQty,
        uom_id: line.uomId,
        created_by: appUserId,
      })),
    });

    const row = await tx.material_return.findUniqueOrThrow({
      where: { material_return_id: header.material_return_id },
      include: MATERIAL_RETURN_LINE_INCLUDE,
    });
    return materialReturnView(row);
  }

  /**
   * 트랜잭션 «밖»의 검증(§4-7 ②~④). 돌려주는 것은 **출발 위치의 공장**이다 —
   * `location.warehouse_id → warehouse.plant_id` 1홉이라 계획 없는 W/O 에서도 선다(§4-7 ④ ⚠).
   */
  private async assertCreatable(input: MaterialReturnCreate): Promise<bigint> {
    const errors: ErrorItem[] = [];
    assertLineShape(input, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const [workOrderCount, location, warehouse, items, lots, uoms] = await Promise.all([
      this.prisma.work_order.count({ where: { work_order_id: input.workOrderId } }),
      this.prisma.location.findUnique({
        where: { location_id: input.sourceLocationId },
        select: { warehouse: { select: { plant_id: true } } },
      }),
      this.prisma.warehouse.findUnique({
        where: { warehouse_id: input.destinationWarehouseId },
        select: { plant_id: true },
      }),
      this.prisma.item.findMany({ where: { item_id: { in: idsOf(input, 'itemId') } }, select: { item_id: true } }),
      this.prisma.lot.findMany({
        where: { lot_id: { in: idsOf(input, 'lotId') } },
        select: { lot_id: true, item_id: true },
      }),
      this.prisma.uom.findMany({ where: { uom_id: { in: idsOf(input, 'uomId') } }, select: { uom_id: true } }),
    ]);

    // ⛔ W/O 는 존재만 본다 — 상태 게이트를 걸지 않는다(계약·화면 침묵 · §4-2 ⓐ).
    if (workOrderCount === 0) errors.push(field('workOrderId', ERROR_CODE.INVALID, '없는 작업지시입니다.'));
    // ⛔ 「생산창고 위치인가」를 검사하지 않는다 — `LOCATION_TYPE` 에 그 축이 없다(§4-2 ⓑ).
    if (location === null) errors.push(field('sourceLocationId', ERROR_CODE.INVALID, '없는 위치입니다.'));
    // ⛔ `WAREHOUSE_TYPE` 으로 「자재창고여야 한다」를 걸지 않는다 — 계약이 안 적었다(§4-2 ⓒ).
    if (warehouse === null) errors.push(field('destinationWarehouseId', ERROR_CODE.INVALID, '없는 창고입니다.'));
    assertLineRefs(input, items, lots, uoms, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const plantId = location?.warehouse.plant_id;
    if (plantId == null) throw one(field('sourceLocationId', ERROR_CODE.INVALID, '공장을 풀 창고가 없습니다.'));
    // ⚠ 계약이 시키지 않은 **이 슬라이스의 유일한 거부**다(R-11) — 두 축이 다른 공장이면
    //    공장 간 이동이 된다. 거부는 완화가 싸다 · R-11 ⇒ 회신이 오면 이 한 자리를 지운다.
    if (warehouse !== null && warehouse.plant_id !== plantId) {
      throw one(field('destinationWarehouseId', ERROR_CODE.INVALID, '출발 위치와 다른 공장의 창고입니다.'));
    }
    return plantId;
  }
}

/**
 * ⚠ 사번을 **읽고 버린다** — `material_return` 에 `worker_id` 도 `requested_by` 도 없고
 * `created_by` 는 `app.app_user` 축이다(I-10 §4-8). 계약 `required: true` 라 부재만 거부한다.
 * `lot-complete.service.ts:164` · `picking-pick.service.ts:163` · `shopfloor-receipt.service.ts:192`
 * 에 이은 **넷째 사본 · 후속 소형 PR 이 옮긴다 — I-10 R-12**(`src/common/http/worker-no.ts`).
 * ⛔ `mdm.worker` 를 조회하지 않는다 — 저장하지 않는 값에 왕복을 늘리지 않는다.
 */
function assertWorkerNo(workerNo: string | undefined): void {
  if (workerNo === undefined || workerNo.trim() === '') {
    throw one(field('X-Worker-No', ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
  }
}

/**
 * 몸통 형식 검증(§4-3 ⓒⓓ) — 본문 안 `(itemId, lotId)` 중복 · 수량 범위.
 * ⛔ 빈 배열의 `LINE_REQUIRED` 를 만들지 않는다 — 계약 `MaterialReturnCreate.lines.minItems = 1`
 *    이 실재해 가드가 400 `RANGE` 로 먼저 막는다(§4-3 ⓑ).
 */
function assertLineShape(input: MaterialReturnCreate, errors: ErrorItem[]): void {
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    const key = `${line.itemId}/${line.lotId}`;
    if (seen.has(key)) {
      // 물리에 그 유일 제약이 없어 같은 LOT 이 두 줄로 실리면 반출량이 두 벌이 된다(§4-3 ⓒ).
      errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '같은 품목·LOT 이 중복됩니다.'));
    }
    seen.add(key);
    if (!(line.returnQty > 0)) {
      errors.push(field(`${at}.returnQty`, ERROR_CODE.RANGE, '반출 수량은 0보다 커야 합니다.'));
    }
  });
}

/** FK 그물의 라인 축(§4-7 ③) — 존재 + `lot.item_id = itemId` 정합. ⛔ 잔량은 안 본다(§4-3 ⓔ). */
function assertLineRefs(
  input: MaterialReturnCreate,
  items: { item_id: bigint }[],
  lots: { lot_id: bigint; item_id: bigint }[],
  uoms: { uom_id: bigint }[],
  errors: ErrorItem[],
): void {
  const itemIds = new Set(items.map((row) => Number(row.item_id)));
  const lotById = new Map(lots.map((row) => [Number(row.lot_id), Number(row.item_id)]));
  const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));

  input.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    if (!itemIds.has(line.itemId)) errors.push(field(`${at}.itemId`, ERROR_CODE.INVALID, '없는 품목입니다.'));
    const lotItemId = lotById.get(line.lotId);
    if (lotItemId === undefined) {
      errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '없는 LOT 입니다.'));
    } else if (lotItemId !== line.itemId) {
      errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, 'LOT 의 품목이 다릅니다.'));
    }
    if (!uomIds.has(line.uomId)) errors.push(field(`${at}.uomId`, ERROR_CODE.INVALID, '없는 단위입니다.'));
  });
}

function idsOf(input: MaterialReturnCreate, key: keyof MaterialReturnCreateLine): number[] {
  return [...new Set(input.lines.map((line) => line[key]))];
}

/** 서버·컨테이너·DB TZ 가 UTC 고정이다(CLAUDE.md) — 채번 기간 키를 그 날짜로 만든다. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
