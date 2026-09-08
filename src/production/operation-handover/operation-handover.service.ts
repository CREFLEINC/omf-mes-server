import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
// ⛔ 새 사본을 만들지 않는다 — 같은 도메인의 것을 그대로 쓴다(I-25 R-6 · 공용화는 #337 몫).
//    `lot-rules.ts` 판은 「없는 사번」 갈래가 없고 `src/trace` 로 도메인 경계를 넘는다.
import { assertWorkerNo } from '../work-session/work-session.service';
import {
  OPERATION_HANDOVER_LINE_INCLUDE,
  OperationHandoverView,
  operationHandoverView,
} from './operation-handover-view';
import { HANDED_OVER } from './operation-handover.constants';

/** 계약 `OperationHandoverLine` — 쓰기에 유효한 칸은 셋뿐이다(`operationHandoverLineId` 는 응답 칸 · §1-3). */
export interface OperationHandoverCreateLine {
  lotId: number;
  handoverQty: number;
  uomId: number;
}

/** 계약 `OperationHandoverCreate` — required 4 · 선택 0(§1-3). */
export interface OperationHandoverCreate {
  fromWorkOrderId: number;
  toWorkOrderId: number;
  handedOverAt: string;
  lines: OperationHandoverCreateLine[];
}

/** 라인의 위치 두 칸(물리 NOT NULL · 계약에 칸 0)은 두 W/O 의 기본 WIP 위치로 푼다(§4-2). */
interface HandoverLocations {
  source: bigint;
  destination: bigint;
}

/**
 * 공정 인계 확정 — 이 슬라이스의 심장(I-25 §4).
 *
 * ⛔ **원장 0 · 상태기계 0**(§8-2 · R-3) — `operation_handover` 에 재고·전기 연결 칸이 0 이고
 *    계약 `description`·`x-internal-note` 에 원장 언급이 0 이다. `document-post` 를 부르지 않고
 *    `transitions.ts` 에 전이를 얹지 않는다(`statusCode` 가 `x-no-code-key` — ⌜전이가 0개다⌝).
 * ⛔ LOT 계보·생명주기·승인·아웃박스·`FOR UPDATE`·ETag 0 · 서비스가 스스로 내는 409 도 0 이다
 *    (유일 제약이 서버 채번인 `handover_no` 하나뿐이라 업무 충돌 축이 없다 · §4-3).
 */
@Injectable()
export class OperationHandoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  async create(
    input: OperationHandoverCreate,
    appUserId: number,
    workerNo: string | undefined,
  ): Promise<OperationHandoverView> {
    await assertWorkerNo(this.prisma, workerNo);
    const locations = await this.assertCreatable(input);
    // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 안에서 부르면 한 요청이 커넥션을 둘
    //    쥐어 풀 고갈 시 `P2024` 로 죽는다(§4-1 ⑤). 결번은 허용한다.
    const no = await this.numbering.next('OPERATION_HANDOVER', null, utcDate(input.handedOverAt));
    return this.prisma.$transaction((tx) => this.write(tx, input, no, locations, appUserId));
  }

  /** §4-1 ⑥~⑧ — 헤더 INSERT → createMany(`line_no` 1..N) → 같은 tx 되읽기. */
  private async write(
    tx: Prisma.TransactionClient,
    input: OperationHandoverCreate,
    handoverNo: string,
    locations: HandoverLocations,
    appUserId: number,
  ): Promise<OperationHandoverView> {
    const handedOverAt = new Date(input.handedOverAt);
    const header = await tx.operation_handover.create({
      data: {
        handover_no: handoverNo,
        from_work_order_id: input.fromWorkOrderId,
        to_work_order_id: input.toWorkOrderId,
        status_code: HANDED_OVER,
        handed_over_at: handedOverAt,
        // ⭐ 계약이 인계·인수를 «한 행위»로 접었다 — ⌜받는 쪽 화면이 없어 `received_at` 을 채울
        //    경로가 생기지 않는다. 화면을 따라 인계 확정 시 두 시각을 함께 찍는다⌝(R-2).
        received_at: handedOverAt,
        created_by: appUserId,
      },
    });
    await tx.operation_handover_line.createMany({
      data: input.lines.map((line, index) => ({
        operation_handover_id: header.operation_handover_id,
        // 계약 라인에 `lineNo` 가 없다 — 본문 순서로 서버가 1..N 을 매긴다(`material-return.service.ts:90`).
        line_no: index + 1,
        source_lot_id: line.lotId,
        handover_qty: line.handoverQty,
        // ⭐ 접힌 것은 시각만이 아니라 «인수» 그 자체다 — 수령량이 인계량과 같다(R-2).
        //    물리 CHECK `ck_handover_qty (received_qty <= handover_qty)` 의 경계에서 늘 만난다.
        received_qty: line.handoverQty,
        uom_id: line.uomId,
        // 모든 라인이 같은 두 값을 받는다 — 계약이 라인별 위치를 안 받는다(§4-2).
        source_location_id: locations.source,
        destination_location_id: locations.destination,
        created_by: appUserId,
      })),
    });

    const row = await tx.operation_handover.findUniqueOrThrow({
      where: { operation_handover_id: header.operation_handover_id },
      include: OPERATION_HANDOVER_LINE_INCLUDE,
    });
    return operationHandoverView(row);
  }

  /**
   * 트랜잭션 «밖»의 검증(§4-1 ②~④). 돌려주는 것은 라인에 실을 **위치 두 칸**이다.
   * ⛔ 본문 안 LOT 중복을 막지 않는다 — 물리에도 계약에도 그 유일 제약이 없다(계획서 밖 · §7-6).
   */
  private async assertCreatable(input: OperationHandoverCreate): Promise<HandoverLocations> {
    const errors: ErrorItem[] = [];
    // CHECK `ck_handover_work_orders` 앞당김 — 위반이 500 으로 새는 것을 막는다(§2).
    if (input.fromWorkOrderId === input.toWorkOrderId) {
      errors.push(field('toWorkOrderId', ERROR_CODE.INVALID, '보내는 작업지시와 받는 작업지시가 같습니다.'));
    }
    input.lines.forEach((line, index) => {
      // CHECK `operation_handover_line_handover_qty_check` 앞당김.
      if (!(line.handoverQty > 0)) {
        errors.push(field(`lines[${index}].handoverQty`, ERROR_CODE.RANGE, '인계 수량은 0보다 커야 합니다.'));
      }
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    const [workOrders, lots, uoms] = await Promise.all([
      this.prisma.work_order.findMany({
        where: { work_order_id: { in: [input.fromWorkOrderId, input.toWorkOrderId].map(BigInt) } },
        select: { work_order_id: true, default_wip_location_id: true },
      }),
      this.prisma.lot.findMany({ where: { lot_id: { in: idsOf(input, 'lotId') } }, select: { lot_id: true } }),
      this.prisma.uom.findMany({ where: { uom_id: { in: idsOf(input, 'uomId') } }, select: { uom_id: true } }),
    ]);
    // ⛔ W/O 는 존재만 본다 — 상태 게이트를 걸지 않는다(계약·화면 침묵).
    const wipById = new Map(workOrders.map((row) => [Number(row.work_order_id), row.default_wip_location_id]));
    // 계약이 이 경로에 404 를 선언하지 않았다 — 없는 참조는 전부 400 `INVALID` 다(§4-1 ③).
    if (!wipById.has(input.fromWorkOrderId)) {
      errors.push(field('fromWorkOrderId', ERROR_CODE.INVALID, '없는 작업지시입니다.'));
    }
    if (!wipById.has(input.toWorkOrderId)) {
      errors.push(field('toWorkOrderId', ERROR_CODE.INVALID, '없는 작업지시입니다.'));
    }
    assertLineRefs(input, lots, uoms, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    return resolveLocations(input, wipById, errors);
  }
}

/**
 * 자리 1 — 라인의 위치 두 칸을 **W/O 기본 WIP 위치**로 채운다. 계약 `x-internal-note` 가
 * ⌜화면이 고르지 않는다 — **서버가 채운다**⌝ 로 직접 시켰다(R-7).
 *
 * ⚠ 선례와 **NULL 정책이 반대**다 — `work-order-release.service.ts:91-93` 은 NULL 이면 거르고
 *   지나가지만 우리는 NOT NULL 자식 칸이라 건너뛸 수가 없다 ⇒ **400** 으로 거부한다. 현장에서는
 *   못 푸는 400 이고(관리웹에서 W/O 기본 WIP 위치를 세우는 것이 선행) 오늘 넣는 값은 W/O
 *   기본값의 «사본»이라 그때의 라인사이드 위치는 복원되지 않는다 — 통보 158.
 */
function resolveLocations(
  input: OperationHandoverCreate,
  wipById: Map<number, bigint | null>,
  errors: ErrorItem[],
): HandoverLocations {
  const source = wipById.get(input.fromWorkOrderId) ?? null;
  const destination = wipById.get(input.toWorkOrderId) ?? null;
  if (source === null) {
    errors.push(field('fromWorkOrderId', ERROR_CODE.INVALID, '작업지시의 기본 WIP 위치가 없습니다.'));
  }
  if (destination === null) {
    errors.push(field('toWorkOrderId', ERROR_CODE.INVALID, '작업지시의 기본 WIP 위치가 없습니다.'));
  }
  if (source === null || destination === null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
  return { source, destination };
}

/** FK 그물의 라인 축(§4-1 ③) — 존재만 본다. ⛔ 잔량·LOT 상태를 안 본다(계약에 칸 0). */
function assertLineRefs(
  input: OperationHandoverCreate,
  lots: { lot_id: bigint }[],
  uoms: { uom_id: bigint }[],
  errors: ErrorItem[],
): void {
  const lotIds = new Set(lots.map((row) => Number(row.lot_id)));
  const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));

  input.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    if (!lotIds.has(line.lotId)) errors.push(field(`${at}.lotId`, ERROR_CODE.INVALID, '없는 LOT 입니다.'));
    if (!uomIds.has(line.uomId)) errors.push(field(`${at}.uomId`, ERROR_CODE.INVALID, '없는 단위입니다.'));
  });
}

function idsOf(input: OperationHandoverCreate, key: keyof OperationHandoverCreateLine): number[] {
  return [...new Set(input.lines.map((line) => line[key]))];
}

/**
 * 채번 기간 키 — **`handedOverAt` 의 UTC 날짜**다(§0 자리 2 ⓑ). 서버 시각이 아니다: 이 계약은
 * 클라이언트가 준 시각을 헤더에 그대로 싣는다. 서버·컨테이너·DB TZ 는 UTC 고정이다(CLAUDE.md).
 */
function utcDate(handedOverAt: string): string {
  return new Date(handedOverAt).toISOString().slice(0, 10);
}
