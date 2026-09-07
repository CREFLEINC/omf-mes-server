import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { CodeCheck, assertCodeValues, optional } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { INSPECTION_RESULT_JOIN, InspectionResultView, inspectionResultView } from './inspection-result-view';
import { CONFIRMED, assertConfirmedShape, assertMeasurementValues } from './inspection-rules';

/** 계약 `InspectionMeasurementInput` — required 4 · 프로퍼티 8. */
export interface InspectionMeasurementInput {
  inspectionItemSpecId: number;
  sampleNo: number;
  numericValue?: number;
  textValue?: string;
  booleanValue?: boolean;
  judgmentCode: string;
  measuredAt: string;
  inspectionEquipmentId?: number;
}

/** 계약 `InspectionResultCreate` — required 8 · 프로퍼티 13. ⛔ 검사자·단말·번호·회차는 본문이 안 받는다. */
export interface InspectionResultCreate {
  inspectionRequestId: number;
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  heldQty: number;
  uomId: number;
  overallJudgmentCode?: string;
  inspectedAt: string;
  statusCode: string;
  previousResultId?: number;
  reinspectionReasonCode?: string;
  measurements?: InspectionMeasurementInput[];
  remarks?: string;
}

/** 본문 밖에서 오는 것. `version`(If-Match)은 이 자리에서 **선택**이다(C-9 오프라인 큐). */
export interface InspectionResultWriteContext {
  workerNo: string | undefined;
  idempotencyKey: string;
  version: number | undefined;
  appUserId: number | undefined;
  terminalId: bigint | null;
}

/** 채번 문서 유형 — `DEFAULT_PREFIX` 의 `IRS`(규칙 미등재 · §1-5). */
const NUMBERING_DOCUMENT = 'INSPECTION_RESULT';
const WORKER_NO = 'X-Worker-No';
/** 계약 `QualityConflictResponse.code` — required 라 409 를 낼 때마다 싣는다. */
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const DUPLICATE_KEY = 'DUPLICATE_KEY';

/**
 * 검사 결과 저장(I-19 PR ③b). `PUT`(수정)은 PR ③c 가 이 클래스에 `update()` 를 더한다.
 * ⛔ `:confirm` 의 부수효과(LOT 품질 축 전이·보류 해제·
 * 의뢰 완료)는 **PR ④** 가 붙인다 — `statusCode=CONFIRMED` 로 온 저장도 같은 함수를 타야 한다고
 * 계약이 적었다(x-internal-note 「확정 경로 둘이 부수효과가 같아야 한다」).
 * ⛔ 다른 도메인 service 호출 0 · import 0(`server-architecture.md`).
 */
@Injectable()
export class InspectionResultWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  async create(body: InspectionResultCreate, context: InspectionResultWriteContext): Promise<InspectionResultView> {
    await this.assertCodes(body.statusCode, body.overallJudgmentCode, body.measurements);
    assertConfirmedShape(body);
    assertMeasurementValues(body.measurements);
    const inspectorId = await this.resolveInspector(context);
    const round = await this.assertReferences(body, context.version);
    const inspectedAt = new Date(body.inspectedAt);
    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 커넥션을 둘 쥐고 풀이 마르면
    //    `P2024` 로 죽는다(`numbering.service.ts:51-53` · I-2 R-2). 결번은 허용한다.
    // ⚠ 기간 키는 `inspectedAt` 의 UTC 날짜다 — 서버가 「오늘」로 다시 잡으면 자정을 넘긴
    //    오프라인 재전송이 하루 뒤 번호를 받는다(I-7 선례 · §5-3).
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
            ...(body.statusCode === CONFIRMED ? { confirmed_at: new Date() } : {}),
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
        return this.reread(tx, created.inspection_result_id);
      })
      .catch((error: unknown) => throwRoundConflict(error));
  }

  /**
   * ⭐ `plan.md` §5-9 의 가름 — 관리웹은 계정 세션, POP 단말은 사번 귀속 헤더다. 계약이 헤더를
   * `WorkerNoOptional` 로 적었으므로 **헤더가 「주체 칸의 유일한 원천」이 아니다** — 없다고 400 을
   * 내지 않는다(그 목록은 `WorkerNo`(필수)를 단 열 자리뿐이고 여기는 아니다).
   * ⚠ 관리자 계정에 `worker` 행이 없으면 관리웹이 검사를 저장할 수 없다 — 설계 미정 · 문의 069+11.
   */
  private async resolveInspector(context: InspectionResultWriteContext): Promise<bigint> {
    const workerNo = context.workerNo;
    if (workerNo !== undefined && workerNo.trim() !== '') {
      const worker = await this.prisma.worker.findUnique({ where: { worker_no: workerNo }, select: { worker_id: true } });
      if (worker === null) throw one(field(WORKER_NO, ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
      return worker.worker_id;
    }
    if (context.appUserId !== undefined) {
      const worker = await this.prisma.worker.findFirst({
        where: { app_user_id: BigInt(context.appUserId) },
        select: { worker_id: true },
      });
      if (worker !== null) return worker.worker_id;
    }
    throw one(field(WORKER_NO, ERROR_CODE.REQUIRED, '검사자를 풀 수 없습니다 — 사번 헤더를 싣거나 계정에 작업자를 연결하세요(문의 069+11).'));
  }

  /**
   * FK 존재 검증(없으면 400 `INVALID` — 이 경로는 404 를 선언하지 않았다) + **회차 결정**.
   * ⭐ 번호·회차·멱등은 서로 다른 축이다(§5-3) — 여기서 정하는 것은 회차 하나뿐이다.
   * ⛔ `previousResultId` 가 «다른 의뢰»의 행이면 거절한다 — 본문의 required 칸을 서버가 조용히
   *    갈아 끼우지 않고(§2 기준 4), 교차-의뢰 자식은 정상 쓰기 경로가 만들 수 있는 모양이 아니다
   *    (그 이상 데이터를 조회가 어떻게 견디는지는 #298 Major 2 가 따로 지킨다).
   * ⚠ `inspectionItemSpecId`·`inspectionEquipmentId` 는 손으로 안 본다 — 공용 FK 그물(`P2003`)이
   *    같은 400 `INVALID` 로 잡고, 그때 번호 하나가 결번으로 남는다(허용).
   */
  private async assertReferences(body: InspectionResultCreate, version: number | undefined): Promise<number> {
    const request = await this.prisma.inspection_request.findUnique({
      where: { inspection_request_id: body.inspectionRequestId },
      select: { inspection_request_id: true, version_no: true },
    });
    if (request === null) throw one(field('inspectionRequestId', ERROR_CODE.INVALID, '없는 검사 의뢰입니다.'));
    // If-Match 는 **선택**이다(오프라인 큐가 토큰을 안 싣는다 · C-9). 값이 오면 의뢰의 버전과
    // 대조한다 — ⚠ 계약이 무엇의 버전인지 안 적었다(결과는 아직 없다). 설계 미정 · 문의 069+10.
    if (version !== undefined && request.version_no !== version) {
      assertUpdated(0, 'user', { code: VERSION_CONFLICT, currentVersion: String(request.version_no) });
    }
    if ((await this.prisma.uom.count({ where: { uom_id: body.uomId } })) === 0) {
      throw one(field('uomId', ERROR_CODE.INVALID, '없는 단위입니다.'));
    }
    if (body.previousResultId === undefined) return 1;

    const previous = await this.prisma.inspection_result.findUnique({
      where: { inspection_result_id: body.previousResultId },
      select: { inspection_request_id: true },
    });
    if (previous === null) throw one(field('previousResultId', ERROR_CODE.INVALID, '없는 앞 회차입니다.'));
    if (previous.inspection_request_id !== request.inspection_request_id) {
      throw one(field('previousResultId', ERROR_CODE.INVALID, '앞 회차가 다른 검사 의뢰의 것입니다.'));
    }
    const max = await this.prisma.inspection_result.aggregate({
      where: { inspection_request_id: request.inspection_request_id },
      _max: { inspection_round: true },
    });
    return (max._max.inspection_round ?? 0) + 1;
  }

  /** ⛔ 종합 판정과 항목 판정은 **그룹이 다르다** — 항목에는 「보류」가 없다(§1-5). */
  private assertCodes(
    statusCode: string | undefined,
    overallJudgmentCode: string | undefined,
    measurements: readonly InspectionMeasurementInput[] | undefined,
  ): Promise<void> {
    const checks: CodeCheck[] = [
      { field: 'overallJudgmentCode', value: overallJudgmentCode, groupCode: 'INSPECTION_RESULT_OVERALL_JUDGMENT' },
      ...(measurements ?? []).map((measurement, index) => ({
        field: `measurements[${index}].judgmentCode`,
        value: measurement.judgmentCode,
        groupCode: 'INSPECTION_MEASUREMENT_JUDGMENT',
      })),
    ];
    if (statusCode !== undefined) checks.push({ field: 'statusCode', value: statusCode, groupCode: 'INSPECTION_RESULT_STATUS' });
    return assertCodeValues(this.prisma, checks);
  }

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

/**
 * `uq_inspection_round(의뢰, 회차)` 충돌은 **409 `DUPLICATE_KEY`** 다 — 재시도하지 않는다(§5-1).
 * 회차 채기를 `FOR UPDATE` 로 잠그지 않는 대가다: 잠그면 의뢰 행을 업무 트랜잭션 내내 쥔다.
 */
function throwRoundConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target ?? '').includes('inspection_round')
  ) {
    throw new ConflictException('user', '같은 의뢰에 같은 회차가 이미 있습니다. 다시 불러온 뒤 저장하세요.', { code: DUPLICATE_KEY });
  }
  throw error;
}
