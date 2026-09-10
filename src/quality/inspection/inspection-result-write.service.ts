import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { optional } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionConfirmService } from './inspection-confirm.service';
import { INSPECTION_RESULT_JOIN, InspectionResultView, inspectionResultView } from './inspection-result-view';
import {
  InspectionMeasurementInput,
  InspectionResultCreate,
  InspectionResultUpdate,
  InspectionResultWriteContext,
} from './inspection-result-write-input';
import {
  VERSION_CONFLICT,
  assertCodes,
  assertReferences,
  bornConfirmed,
  resolveInspector,
  throwRoundConflict,
} from './inspection-result-write-rules';
import { CONFIRMED, assertConfirmedShape, assertMeasurementValues, assertQuantityBounds } from './inspection-rules';

/** 채번 문서 유형 — `DEFAULT_PREFIX` 의 `IRS`(규칙 미등재 · §1-5). */
const NUMBERING_DOCUMENT = 'INSPECTION_RESULT';
/** 계약 `QualityConflictResponse.code` — required 라 409 를 낼 때마다 싣는다. */
const INVALID_STATE = 'INVALID_STATE';

/**
 * 검사 결과 저장(PR ③b) · 수정(PR ③c).
 * ⭐ **`statusCode=CONFIRMED` 로 온 저장은 `:confirm` 과 «같은» 부수효과를 낸다**(§12-1 ⓑ 상환) —
 * 같은 트랜잭션에서 `InspectionConfirmService.applyConfirmEffects()` 를 부른다. 계약
 * `x-internal-note` 가 확정 경로 둘의 부수 효과가 같아야 한다고 못 박았고, 오프라인 큐는 서버가
 * 만든 id 를 몰라 `:confirm` 을 못 부르므로 **이 경로가 큐의 유일한 확정**이다(`plan-uiux.md:1112`).
 * ⛔ 다른 도메인 service 호출 0 · import 0 — 부르는 상대는 **같은 도메인**이다(`server-architecture.md`).
 */
@Injectable()
export class InspectionResultWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly confirms: InspectionConfirmService,
  ) {}

  async create(body: InspectionResultCreate, context: InspectionResultWriteContext): Promise<InspectionResultView> {
    await assertCodes(this.prisma, body.statusCode, body.overallJudgmentCode, body.measurements);
    // 물리 하한이 먼저다 — 여기서 안 막으면 CHECK 위반이 500 으로 나간다(작성중도 그대로 산다).
    assertQuantityBounds(body);
    assertConfirmedShape(body);
    assertMeasurementValues(body.measurements);
    const inspectorId = await resolveInspector(this.prisma, context);
    const round = await assertReferences(this.prisma, body, context.version);
    const inspectedAt = new Date(body.inspectedAt);
    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 커넥션을 둘 쥐고 풀이 마르면
    //    `P2024` 로 죽는다(`numbering.service.ts:51-53` · I-2 R-2). 결번은 허용한다.
    // ⚠ 기간 키는 `inspectedAt` 의 UTC 날짜다 — 서버가 「오늘」로 다시 잡으면 자정을 넘긴
    //    오프라인 재전송이 하루 뒤 번호를 받는다(I-7 선례 · §5-3).
    // 확정으로 태어나는 저장은 시각·주체를 트랜잭션 «밖»에서 한 번 정한다 — `confirmed_at` 과
    // LOT 이력·보류 해제가 같은 시각을 써야 한다. 작성중이면 `undefined` 다.
    // ⭐ 그 판정이 채번 «앞»이다(#320 m-2) — 뒤에 두면 세션 없는 확정 저장이 번호 하나를
    //    결번으로 남기고 401 을 받는다. 결번 자체는 허용이지만 순서만 바꾸면 안 생긴다.
    const born = body.statusCode === CONFIRMED ? bornConfirmed(context) : undefined;
    const resultNo = await this.numbering.next(NUMBERING_DOCUMENT, null, inspectedAt.toISOString().slice(0, 10));

    return this.prisma
      .$transaction(async (tx) => {
        const created = await tx.inspection_result.create({
          data: {
            inspection_result_no: resultNo,
            inspection_request_id: BigInt(body.inspectionRequestId),
            inspection_round: round,
            inspected_qty: body.inspectedQty,
            accepted_qty: body.acceptedQty,
            rejected_qty: body.rejectedQty,
            held_qty: body.heldQty,
            uom_id: BigInt(body.uomId),
            ...optional('overall_judgment_code', body.overallJudgmentCode),
            // 귀속(`inspector_id`)은 헤더·세션이, 주체(`created_by`)는 세션이 준다 — 두 칸이 다르다.
            inspector_id: inspectorId,
            inspected_at: inspectedAt,
            // 확정으로 태어나면 확정 시각이 함께 찬다. 작성중이면 비운다(키 생략 = NULL 기본).
            ...optional('confirmed_at', born?.changedAt),
            ...optional('terminal_id', context.terminalId ?? undefined),
            status_code: body.statusCode,
            ...optional('previous_result_id', body.previousResultId === undefined ? undefined : BigInt(body.previousResultId)),
            // ⛔ `REINSPECTION_REASON` 은 열린 그룹이라 대조를 걸지 않는다(§1-5 · I-6 §9-1 #2).
            ...optional('reinspection_reason_code', body.reinspectionReasonCode),
            // 헤더 값 «그대로» — 멱등 기록이 만료된 뒤의 재전송을 이 UNIQUE 가 둘째 그물로 막는다.
            idempotency_key: context.idempotencyKey,
            ...optional('remarks', body.remarks),
            created_by: context.appUserId,
          },
          select: { inspection_result_id: true },
        });
        await this.writeMeasurements(tx, created.inspection_result_id, body.measurements, context.appUserId);
        if (born !== undefined) {
          await this.confirms.applyConfirmEffects(tx, {
            ...born,
            inspectionResultId: created.inspection_result_id,
            inspectionRequestId: BigInt(body.inspectionRequestId),
            // `assertConfirmedShape()` 가 확정에는 판정이 있음을 이미 400 으로 강제했다.
            judgment: body.overallJudgmentCode as string,
            rejectedQty: body.rejectedQty,
          });
        }
        return this.reread(tx, created.inspection_result_id);
      })
      .catch((error: unknown) => throwRoundConflict(error));
  }

  /**
   * ⭐ **작성중인 것만 고친다** — 확정본은 **409 `INVALID_STATE`** 다. 계약이 이 자리에만 409 를
   * 문자로 적었다(「작성중인 결과만 고칠 수 있다. 확정된 것은 409 INVALID_STATE — 고치는 것이
   * 아니라 재검이다(B-10)」). ⛔ `:confirm` 의 재확정은 400 `STATE_LOCKED` 라 **봉투가 다르다**.
   *
   * 버전 대조가 상태 게이트보다 «먼저»다 — 형제 `:release`·`:close` 선례
   * (`work-order-write.service.ts:78` · `production-result.service.ts` 의 `assertVersion` 순서).
   * 낡은 토큰으로 확정본을 건드리면 「다시 불러오라」가 먼저 나와야 한다.
   */
  async update(
    inspectionResultId: number,
    version: number,
    body: InspectionResultUpdate,
    context: InspectionResultWriteContext,
  ): Promise<{ view: InspectionResultView; versionNo: number }> {
    await assertCodes(this.prisma, undefined, body.overallJudgmentCode, body.measurements);
    assertQuantityBounds(body);
    assertMeasurementValues(body.measurements);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.inspection_result.findUnique({
        where: { inspection_result_id: inspectionResultId },
        select: { status_code: true, version_no: true },
      });
      if (current === null) throw new NotFoundException('없는 검사 결과입니다.');
      const currentVersion = String(current.version_no);
      if (current.version_no !== version) {
        assertUpdated(0, 'user', { code: VERSION_CONFLICT, currentVersion });
      }
      if (current.status_code === CONFIRMED) {
        throw new ConflictException('user', '확정된 검사 결과는 고칠 수 없습니다 — 번복은 재검 회차입니다.', { code: INVALID_STATE });
      }
      // ⛔ 수량 합을 강제하지 않는다 — 작성중이라 M-e ⓑ 뒤 DB 도 안 잡는다(§5-2). 확정으로 넘어갈 때
      //    `:confirm`(PR ④)이 잡는다. ⛔ `statusCode` 를 안 바꾼다 — 계약 본문에 그 칸이 없다.
      const updated = await tx.inspection_result.updateMany({
        where: { inspection_result_id: inspectionResultId, version_no: version },
        data: {
          ...optional('inspected_qty', body.inspectedQty),
          ...optional('accepted_qty', body.acceptedQty),
          ...optional('rejected_qty', body.rejectedQty),
          ...optional('held_qty', body.heldQty),
          ...optional('overall_judgment_code', body.overallJudgmentCode),
          ...optional('inspected_at', body.inspectedAt === undefined ? undefined : new Date(body.inspectedAt)),
          ...optional('remarks', body.remarks),
          updated_by: context.appUserId ?? null,
          version_no: { increment: 1 },
        },
      });
      // 위 대조를 지난 뒤 같은 행을 누가 옮겼을 때의 둘째 그물 — 조건부 UPDATE 가 0행이면 그것이다.
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion });
      // ⭐ **치환**이다 — 실으면 그 결과의 측정치 전건을 갈아 끼우고, **생략하면 손대지 않는다**
      //    (빈 배열과 다르다 · §1-3). 부분 병합이 아니다 — 계약이 「부분」을 적지 않았다.
      if (body.measurements !== undefined) {
        await tx.inspection_measurement.deleteMany({ where: { inspection_result_id: BigInt(inspectionResultId) } });
        await this.writeMeasurements(tx, BigInt(inspectionResultId), body.measurements, context.appUserId);
      }
      return { view: await this.reread(tx, BigInt(inspectionResultId)), versionNo: current.version_no + 1 };
    });
  }

  /**
   * ⭐ `plan.md` §5-9 의 가름 — 관리웹은 계정 세션, POP 단말은 사번 귀속 헤더다. 계약이 헤더를
   * `WorkerNoOptional` 로 적었으므로 **헤더가 「주체 칸의 유일한 원천」이 아니다** — 없다고 400 을
   * 내지 않는다(그 목록은 `WorkerNo`(필수)를 단 열 자리뿐이고 여기는 아니다).
   * ⚠ 관리자 계정에 `worker` 행이 없으면 관리웹이 검사를 저장할 수 없다 — 설계 미정 · 미발행 · I-19 §9-2 후보 11.
   */

  private async writeMeasurements(
    tx: Prisma.TransactionClient,
    inspectionResultId: bigint,
    measurements: readonly InspectionMeasurementInput[] | undefined,
    appUserId: number | undefined,
  ): Promise<void> {
    if (measurements === undefined || measurements.length === 0) return;
    await tx.inspection_measurement.createMany({
      data: measurements.map((measurement) => ({
        inspection_result_id: inspectionResultId,
        inspection_item_spec_id: BigInt(measurement.inspectionItemSpecId),
        sample_no: measurement.sampleNo,
        ...optional('numeric_value', measurement.numericValue),
        ...optional('text_value', measurement.textValue),
        ...optional('boolean_value', measurement.booleanValue),
        judgment_code: measurement.judgmentCode,
        measured_at: new Date(measurement.measuredAt),
        ...optional('inspection_equipment_id', measurement.inspectionEquipmentId === undefined ? undefined : BigInt(measurement.inspectionEquipmentId)),
        created_by: appUserId ?? null,
      })),
    });
  }

  /** 응답은 조회(PR ②b)와 **같은 매퍼**를 탄다 — 저장 직후 화면이 목록과 다른 모양을 보면 안 된다. */
  private async reread(tx: Prisma.TransactionClient, inspectionResultId: bigint): Promise<InspectionResultView> {
    const row = await tx.inspection_result.findUniqueOrThrow({
      where: { inspection_result_id: inspectionResultId },
      include: INSPECTION_RESULT_JOIN,
    });
    return inspectionResultView(row);
  }
}

