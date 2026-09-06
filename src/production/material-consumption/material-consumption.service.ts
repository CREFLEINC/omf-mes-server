import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { optional } from '../../common/master';
import { BOM_COMPONENT_SELECT } from '../../core/bom';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialConsumptionView, materialConsumptionView } from './material-consumption-view';
import { CONSUMPTION_STATUS, CONSUMPTION_TYPE_DEFAULT, LOT_NORMAL } from './material-consumption.constants';

/** 채번 문서 유형 — 규칙 미등재라 `DEFAULT_PREFIX` 의 `MC` 로 자동 등재된다(§3-11). */
const NUMBERING_DOCUMENT = 'MATERIAL_CONSUMPTION';
const WORKER_NO = 'X-Worker-No';

/** 계약 `MaterialConsumptionCreate` — required 6 · 선택 11(I-10 §1-3). */
export interface MaterialConsumptionCreate {
  workOrderId: number;
  itemId: number;
  lotId: number;
  inputQty: number;
  uomId: number;
  occurredAt: string;
  workSessionId?: number;
  consumptionTypeCode?: string;
  changeReasonCode?: string;
  replacedConsumptionId?: number;
  enteredQty?: number;
  enteredUomId?: number;
  lateEntryReasonCode?: string;
  remarks?: string;
  /**
   * ⭐ 계약이 ⌜화면은 이 값을 보내지 않는다 — 서버가 채운다⌝ 라 적은 셋. 와도 **무시하고
   * 서버 값으로 덮는다** — 400 을 내지 않는다(거부는 계약 문장 밖이고, 되돌릴 때 완화가 싸다).
   */
  shopfloorReceiptLineId?: number;
  bomComponentId?: number;
  actualUseProcessId?: number;
}

/** 본문 밖에서 오는 것. If-Match 는 **받되 무시한다** — 신규 생성이라 대조할 버전이 없다(§3-12). */
export interface MaterialConsumptionContext {
  workerNo: string | undefined;
  idempotencyKey: string;
  appUserId: number | undefined;
}

/** 트랜잭션 «밖»에서 다 푼 값 — 안에서는 INSERT 와 되읽기만 한다. */
interface Resolved {
  workerId: bigint;
  bomComponentId: bigint;
  actualUseProcessId: bigint | null;
  shopfloorReceiptLineId: bigint | null;
  plantId: bigint;
  occurredAt: Date;
}

/**
 * 자재 투입 등록 — I-10 의 심장(§3). ⛔ 원장을 지나지 않고(`plan.md` §5 #8) ⛔ 계보
 * (`trace.lot_relation`)·배분(`material_usage_allocation`)을 만들지 않으며(§3-9·§3-10 —
 * `target_lot_id` 를 가릴 축이 계약·화면·물리 어디에도 없다 · 문의 052) ⛔ `FOR UPDATE`·
 * `lot_lifecycle_history`·ETag 가 없다(§3-13).
 * ⛔ 다른 전표의 service 를 부르지 않는다 — `resolveWorker` 는 **복제**한다(§3-7).
 */
@Injectable()
export class MaterialConsumptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  async create(body: MaterialConsumptionCreate, context: MaterialConsumptionContext): Promise<MaterialConsumptionView> {
    // ① 헤더 부재가 먼저다 — 본문을 다 통과해도 귀속 주체가 없으면 저장할 수 없다.
    const workerId = await this.resolveWorker(context.workerNo);
    const errors: ErrorItem[] = [];
    assertShape(body, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const resolved = await this.resolve(body, workerId);
    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 커넥션을 둘 쥐고 풀이 마르면
    //    `P2024` 로 죽는다(I-2 R-2 · `production-result.service.ts:77-82`). 결번은 허용한다.
    // ⚠ 기간 키가 `occurredAt` 의 UTC 날짜다(I-7 `:81` 과 같은 처리) — 이 표는 `business_date` 를
    //    안 실어 C-8 미해당이고, 서버가 「오늘」로 다시 잡으면 재전송이 하루 뒤 번호를 받는다.
    const period = resolved.occurredAt.toISOString().slice(0, 10);
    const consumptionNo = await this.numbering.next(NUMBERING_DOCUMENT, resolved.plantId, period);
    return this.prisma.$transaction((tx) => this.write(tx, body, context, resolved, consumptionNo));
  }

  /** ⑧ INSERT → ⑨ 같은 tx 되읽기(§3-1). 잠금도 원장도 계보도 없다. */
  private async write(
    tx: Prisma.TransactionClient,
    body: MaterialConsumptionCreate,
    context: MaterialConsumptionContext,
    resolved: Resolved,
    consumptionNo: string,
  ): Promise<MaterialConsumptionView> {
    const created = await tx.material_consumption.create({
      data: {
        consumption_no: consumptionNo,
        work_order_id: BigInt(body.workOrderId),
        ...ref('work_session_id', body.workSessionId),
        // ⭐ 본문 값이 아니라 서버가 푼 값이다 — 계약이 세 칸을 ⌜화면은 보내지 않는다⌝ 로 적었다.
        ...optional('shopfloor_receipt_line_id', resolved.shopfloorReceiptLineId ?? undefined),
        bom_component_id: resolved.bomComponentId,
        item_id: BigInt(body.itemId),
        lot_id: BigInt(body.lotId),
        // 값 목록이 0행이라 대조를 걸지 않는다 — 걸면 보낸 값이 전건 400 이 된다(§3-6 ⓐ).
        consumption_type_code: body.consumptionTypeCode ?? CONSUMPTION_TYPE_DEFAULT,
        ...ref('replaced_consumption_id', body.replacedConsumptionId),
        ...optional('change_reason_code', body.changeReasonCode),
        ...optional('actual_use_process_id', resolved.actualUseProcessId ?? undefined),
        input_qty: body.inputQty,
        // `actual_consumed_qty` 는 DEFAULT 0 — 올리는 오퍼레이션이 계약에 0건이다(§3-6 ⓓ).
        uom_id: BigInt(body.uomId),
        // 받은 그대로다 — 환산도 대조도 하지 않는다(§3-8 · 계약이 `inputQty` 를 required 로 받는다).
        ...optional('entered_qty', body.enteredQty),
        ...ref('entered_uom_id', body.enteredUomId),
        occurred_at: resolved.occurredAt,
        // `recorded_at` 은 DB 기본값(`clock_timestamp()`) — 서버 수신 시각이다.
        ...optional('late_entry_reason_code', body.lateEntryReasonCode),
        // 귀속(`worker_id`)은 헤더가, 주체(`created_by`)는 세션이 준다 — 두 칸이 다르다.
        worker_id: resolved.workerId,
        // ⛔ `terminal_id` 를 넣지 않는다 — 단말 토큰 «검증» 축이 0건이라 풀 값이 없다(문의 054).
        status_code: CONSUMPTION_STATUS,
        // 헤더 값 «그대로» — 멱등 기록이 만료된 뒤의 재전송을 이 UNIQUE 가 둘째 그물로 막는다(§3-12).
        idempotency_key: context.idempotencyKey,
        ...optional('remarks', body.remarks),
        created_by: context.appUserId,
      },
      select: { material_consumption_id: true },
    });
    const row = await tx.material_consumption.findUniqueOrThrow({
      where: { material_consumption_id: created.material_consumption_id },
    });
    return materialConsumptionView(row);
  }

  /** ③ FK 그물 → ④ 오투입 판정 → ⑤ 수령 라인 귀속 → ⑥ 공장(§3-1). 전부 트랜잭션 «밖»이다. */
  private async resolve(body: MaterialConsumptionCreate, workerId: bigint): Promise<Resolved> {
    const errors: ErrorItem[] = [];
    const workOrder = await this.assertReferences(body, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    // ⓒ 긴급 W/O 는 오늘 발행되지 않는다 — I-6·문의 040. 계약 ⌜못 찾으면 거절⌝ 에 「길이 없음」도 든다.
    // 계획만 보면 된다 — `bom_id`·`production_order.plant_id` 가 둘 다 NOT NULL 이라 갈래가 하나다.
    const plan = workOrder.production_plan;
    if (plan === null) throw one(field('itemId', ERROR_CODE.INVALID, '자재 명세를 풀 계획이 없습니다(문의 040).'));
    // 같은 품목이 두 줄이면 `sequence_no` 첫 줄 — 품목 유일 제약이 없다(`uq_bom_component` 는 순번 축).
    const component = await this.prisma.bom_component.findFirst({
      where: { bom_id: plan.bom_id, component_item_id: BigInt(body.itemId) },
      orderBy: { sequence_no: 'asc' },
      select: BOM_COMPONENT_SELECT,
    });
    // ⭐ 오투입 3축에서 «막는 것은 이 하나»다 — 출고 귀속·교차 투입은 기록만 한다(§3-3).
    // ⛔ `component.uom_id` 와 `uomId` 를 대조하지 않는다 — 계약이 두 칸의 관계를 안 적었다(I-10 R-7).
    if (component === null) throw one(field('itemId', ERROR_CODE.INVALID, '자재 명세에 없는 품목입니다.'));

    return {
      workerId,
      bomComponentId: component.bom_component_id,
      // 계약 ⌜서버가 이 W/O 의 공정으로 채운다⌝ — `routing_operation` 1홉이다(§3-6 ⓒ).
      actualUseProcessId: workOrder.routing_operation.process_id,
      shopfloorReceiptLineId: await this.receiptLineOf(body),
      plantId: plan.production_order.plant_id,
      occurredAt: new Date(body.occurredAt),
    };
  }

  /**
   * ③ 축마다 한 번. 없는 참조는 **400 `INVALID`** 다 — 계약이 이 경로에 404 를 선언하지
   * 않았다(§1-1). `P2003` 으로 흘리면 어느 칸인지 못 짚는다.
   * ⛔ `work_order.status_code` 를 안 본다 — 어느 상태에서 투입을 받는지 계약·화면이 침묵한다(§3-2 ⓐ).
   */
  private async assertReferences(body: MaterialConsumptionCreate, errors: ErrorItem[]) {
    const [workOrder, lot, itemCount, uomCount, enteredUomCount, session, replaced] = await Promise.all([
      this.prisma.work_order.findUnique({
        where: { work_order_id: BigInt(body.workOrderId) },
        select: {
          production_plan: { select: { bom_id: true, production_order: { select: { plant_id: true } } } },
          routing_operation: { select: { process_id: true } },
        },
      }),
      this.prisma.lot.findUnique({
        where: { lot_id: BigInt(body.lotId) },
        select: { item_id: true, status_code: true },
      }),
      this.prisma.item.count({ where: { item_id: BigInt(body.itemId) } }),
      // ⛔ `uom` 은 **존재만** 본다(I-10 R-7).
      this.prisma.uom.count({ where: { uom_id: BigInt(body.uomId) } }),
      // 안 온 선택 FK 는 조회를 건너뛰고 「통과」로 센다.
      body.enteredUomId === undefined ? 1 : this.prisma.uom.count({ where: { uom_id: BigInt(body.enteredUomId) } }),
      body.workSessionId === undefined
        ? undefined
        : this.prisma.work_session.findUnique({
            where: { work_session_id: BigInt(body.workSessionId) },
            select: { work_order_id: true },
          }),
      body.replacedConsumptionId === undefined
        ? undefined
        : this.prisma.material_consumption.findUnique({
            where: { material_consumption_id: BigInt(body.replacedConsumptionId) },
            select: { work_order_id: true },
          }),
    ]);

    if (workOrder === null) errors.push(field('workOrderId', ERROR_CODE.INVALID, '없는 작업지시입니다.'));
    if (itemCount === 0) errors.push(field('itemId', ERROR_CODE.INVALID, '없는 품목입니다.'));
    if (uomCount === 0) errors.push(field('uomId', ERROR_CODE.INVALID, '없는 단위입니다.'));
    if (enteredUomCount === 0) errors.push(field('enteredUomId', ERROR_CODE.INVALID, '없는 단위입니다.'));
    if (lot === null) {
      errors.push(field('lotId', ERROR_CODE.INVALID, '없는 LOT 입니다.'));
    } else if (lot.item_id !== BigInt(body.itemId)) {
      // LOT 과 품목이 갈리면 계보의 출발점이 거짓이 된다(§3-4 ⓓ).
      errors.push(field('lotId', ERROR_CODE.INVALID, '품목이 다른 LOT 입니다.'));
    } else if (lot.status_code !== LOT_NORMAL) {
      // `P-02-03` §5-2 ⌜`NORMAL` → 투입 가능 · 나머지 셋은 ⛔ 차단⌝.
      errors.push(field('lotId', ERROR_CODE.INVALID, '투입할 수 없는 상태의 LOT 입니다.'));
    }
    // 세션은 존재 + **그 W/O 소속**까지 본다 — 읽는 김에 한 줄이고 나중에 푸는 쪽이 완화다(§3-2 ⓑ).
    assertBelongs('workSessionId', session, body.workOrderId, errors, '없는 작업 세션입니다.');
    // 러닝체인지는 같은 W/O 안에서 일어난다 — `P-02-11` R42(§3-14). 체인 중복은 안 본다.
    assertBelongs('replacedConsumptionId', replaced, body.workOrderId, errors, '없는 투입입니다.');
    return workOrder as NonNullable<typeof workOrder>;
  }

  /**
   * ⑤ 귀속 — 이 W/O 의 수령 라인 중 같은 (품목, LOT) 의 **최신 PK** 한 줄. 없으면 NULL 이고
   * 그래도 투입은 선다(계약 ⌜출고 귀속 무관⌝).
   * ⛔ `received_qty` 상한을 검사하지 않는다 — 수령 라인에 소진량 칸이 없어 누계를 못 센다(§3-5).
   * ⛔ `picking_line`·`goods_issue_line` 을 직접 읽지 않는다(I-8 §9-4 인계 규약).
   */
  private async receiptLineOf(body: MaterialConsumptionCreate): Promise<bigint | null> {
    const line = await this.prisma.shopfloor_receipt_line.findFirst({
      where: {
        shopfloor_receipt: { work_order_id: BigInt(body.workOrderId) },
        item_id: BigInt(body.itemId),
        lot_id: BigInt(body.lotId),
      },
      orderBy: { shopfloor_receipt_line_id: 'desc' },
      select: { shopfloor_receipt_line_id: true },
    });
    return line?.shopfloor_receipt_line_id ?? null;
  }

  /**
   * 귀속 사번 → `worker_id`. `production-result.service.ts:166-176` 의 **둘째 사본**이다 —
   * 전표 간 service 호출을 만들지 않는다(I-10 R-9 · §3-7).
   * ⛔ `app_user_id` 로 세션 사용자에서 도출하지 않는다 · ⛔ 재직 여부를 안 본다.
   */
  private async resolveWorker(workerNo: string | undefined): Promise<bigint> {
    if (workerNo === undefined || workerNo.trim() === '') {
      throw one(field(WORKER_NO, ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
    }
    const worker = await this.prisma.worker.findUnique({
      where: { worker_no: workerNo },
      select: { worker_id: true },
    });
    if (worker === null) throw one(field(WORKER_NO, ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
    return worker.worker_id;
  }
}

/**
 * ② 형식 — 400 을 모아 던진다. `occurredAt` 의 형식은 계약 검증 가드(`format: date-time`)가 본다.
 * 짝 검사는 물리 CHECK(`ck_material_consumption_entered`)를 앞당긴 것이다 — 위반이 공용 그물에
 * 안 걸려 500 으로 샌다(I-3 A3 선례).
 */
function assertShape(body: MaterialConsumptionCreate, errors: ErrorItem[]): void {
  if (!(body.inputQty > 0)) errors.push(field('inputQty', ERROR_CODE.RANGE, '투입 수량은 0 보다 커야 합니다.'));
  const entered = [body.enteredQty, body.enteredUomId].filter((value) => value !== undefined).length;
  if (entered === 1) errors.push(field('enteredQty', ERROR_CODE.PAIR, '입력 수량과 입력 단위는 함께 옵니다.'));
  // `app.qty_t` 의 `CHECK (VALUE >= 0)` 앞당김 — 계약에 `minimum` 이 없어 음수가 그대로 온다.
  if (body.enteredQty !== undefined && !(body.enteredQty >= 0)) {
    errors.push(field('enteredQty', ERROR_CODE.RANGE, '입력 수량은 0 보다 작을 수 없습니다.'));
  }
  // `app.code_t` 도메인 CHECK 가 빈 문자열을 거부하는데 공용 그물이 CHECK 위반을 안 잡아 500 으로 샌다 — 앞당김.
  const codes: [string, string | undefined][] = [
    ['consumptionTypeCode', body.consumptionTypeCode],
    ['changeReasonCode', body.changeReasonCode],
    ['lateEntryReasonCode', body.lateEntryReasonCode],
  ];
  for (const [name, value] of codes) {
    if (value !== undefined && value.trim() === '') {
      errors.push(field(name, ERROR_CODE.REQUIRED, '빈 값을 보낼 수 없습니다.'));
    }
  }
}

/** 존재 + 「그 W/O 소속인가」를 한 자리에서 본다 — 두 선택 FK 가 같은 모양이다. */
function assertBelongs(
  name: string,
  row: { work_order_id: bigint } | null | undefined,
  workOrderId: number,
  errors: ErrorItem[],
  missing: string,
): void {
  if (row === undefined) return;
  if (row === null) errors.push(field(name, ERROR_CODE.INVALID, missing));
  else if (row.work_order_id !== BigInt(workOrderId)) {
    errors.push(field(name, ERROR_CODE.INVALID, '다른 작업지시의 것입니다.'));
  }
}

/** 선택 FK — 본문의 `int64` 를 옮기되 없으면 칸 자체를 안 넣는다. */
function ref(column: string, value: number | undefined): Record<string, unknown> {
  return optional(column, value === undefined ? undefined : BigInt(value));
}
