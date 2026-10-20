import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { CodeCheck, assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InspectionMeasurementInput,
  InspectionResultCreate,
  InspectionResultWriteContext,
} from './inspection-result-write-input';
import { JudgmentQuantities, assertJudgmentChangeReason } from './inspection-rules';

/**
 * 검사 결과 쓰기의 **판정** — 쓰기 서비스에서 떼어 냈다(#337 ⓒ · #320 m-4).
 *
 * 남은 쪽(`inspection-result-write.service.ts`)이 「무엇을 저장하는가」이고 여기가 「저장해도
 * 되는가」다. 넷 다 `this` 를 안 쓰던 것들이라 자유 함수로 나온다 — `prisma` 만 받는다.
 * 선례 — `inspection-rules.ts`(순수 판정) · `downtime-rules.ts`(`tx` 를 받는 판정).
 */

const WORKER_NO = 'X-Worker-No';
/** 계약 `QualityConflictResponse.code` — required 라 409 를 낼 때마다 싣는다. */
export const VERSION_CONFLICT = 'VERSION_CONFLICT';
const DUPLICATE_KEY = 'DUPLICATE_KEY';

/**
 * 검사자(`inspector_id`)를 푼다 — 사번 헤더가 먼저고, 없으면 계정에 연결된 작업자다.
 *
 * ⛔ **`WorkerNoOptional` 자리라 공용 `resolveWorkerId` 로 안 접힌다**(#337 · `worker-no.ts` 머리
 * 주석 ⓑ) — 그 셋은 부재를 400 으로 막는데 여기는 **계정 폴백**이 있어 부재가 곧 오류가 아니다.
 * 둘 다 없을 때에만 400 이다.
 */
/**
 * 관리웹 계정에 지정된 작업자 — 없으면 400(omf-all-around#104). 작성·수정·확정 셋이 같은 규칙을 쓴다:
 * 지정을 해제한 계정이 앞서 만든 임시저장을 고치거나 확정하는 길도 함께 닫는다.
 */
export async function assertAccountWorker(
  prisma: Pick<PrismaService, 'worker'> | Prisma.TransactionClient,
  appUserId: number,
): Promise<bigint> {
  const linked = await prisma.worker.findFirst({ where: { app_user_id: BigInt(appUserId) }, select: { worker_id: true } });
  if (linked === null) {
    throw one(field(WORKER_NO, ERROR_CODE.REQUIRED, '이 계정에 지정된 작업자가 없어 판정을 저장할 수 없습니다 — 사용자 관리에서 작업자를 지정하세요.'));
  }
  return linked.worker_id;
}

export async function resolveInspector(
  prisma: PrismaService,
  context: InspectionResultWriteContext,
): Promise<bigint> {
  const workerNo = context.workerNo;
  // ⛔ 관리웹 계정(단말 아님)은 계정에 «지정된» 작업자가 있어야 저장한다(omf-all-around#104 · 2026-10-16 담당자 검증) —
  //    지정을 해제한 계정이 사번 헤더만 실어 저장하던 빈틈을 닫는다. 지정된 계정의 헤더 우선(§5-5)은 그대로다.
  if (context.terminalId === null && context.appUserId !== undefined) {
    const linked = await assertAccountWorker(prisma, context.appUserId);
    if (workerNo === undefined || workerNo.trim() === '') return linked;
  }
  if (workerNo !== undefined && workerNo.trim() !== '') {
    const worker = await prisma.worker.findUnique({ where: { worker_no: workerNo }, select: { worker_id: true } });
    if (worker === null) throw one(field(WORKER_NO, ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
    return worker.worker_id;
  }
  if (context.appUserId !== undefined) {
    const worker = await prisma.worker.findFirst({
      where: { app_user_id: BigInt(context.appUserId) },
      select: { worker_id: true },
    });
    if (worker !== null) return worker.worker_id;
  }
  throw one(field(WORKER_NO, ERROR_CODE.REQUIRED, '검사자를 풀 수 없습니다 — 사번 헤더를 싣거나 계정에 작업자를 연결하세요.'));
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
export async function assertReferences(
  prisma: PrismaService,
  body: InspectionResultCreate,
  version: number | undefined,
): Promise<number> {
  const request = await prisma.inspection_request.findUnique({
    where: { inspection_request_id: body.inspectionRequestId },
    select: {
      inspection_request_id: true,
      version_no: true,
      inspection_type_code: true,
      lot: { select: { status_code: true } },
    },
  });
  if (request === null) throw one(field('inspectionRequestId', ERROR_CODE.INVALID, '없는 검사 의뢰입니다.'));
  // If-Match 는 **선택**이다(오프라인 큐가 토큰을 안 싣는다 · C-9). 값이 오면 의뢰의 버전과
  // 대조한다 — ⚠ 계약이 무엇의 버전인지 안 적었다(결과는 아직 없다). 설계 미정 · 미발행 · I-19 §9-2 후보 10.
  if (version !== undefined && request.version_no !== version) {
    assertUpdated(0, 'user', { code: VERSION_CONFLICT, currentVersion: String(request.version_no) });
  }
  if ((await prisma.uom.count({ where: { uom_id: body.uomId } })) === 0) {
    throw one(field('uomId', ERROR_CODE.INVALID, '없는 단위입니다.'));
  }
  if (body.previousResultId === undefined) return 1;

  const previous = await prisma.inspection_result.findUnique({
    where: { inspection_result_id: body.previousResultId },
    select: { inspection_request_id: true },
  });
  if (previous === null) throw one(field('previousResultId', ERROR_CODE.INVALID, '없는 앞 회차입니다.'));
  if (previous.inspection_request_id !== request.inspection_request_id) {
    throw one(field('previousResultId', ERROR_CODE.INVALID, '앞 회차가 다른 검사 의뢰의 것입니다.'));
  }
  assertIqcReinspectable(request.inspection_type_code, request.lot?.status_code);
  const max = await prisma.inspection_result.aggregate({
    where: { inspection_request_id: request.inspection_request_id },
    _max: { inspection_round: true },
  });
  return (max._max.inspection_round ?? 0) + 1;
}

/**
 * IQC 재검사 회차는 LOT 이 «검사 대기»일 때만 받는다(omf-all-around#106 · 3단계 검증 2026-10-16).
 *
 * ⛔ 불합격(불량) LOT 은 처분 판정을 거쳐야 한다 — 재작업이 검사 대기로 되돌린 뒤에 재검사한다(장부 P-43). 이 가드가 없을 때
 *    API 로는 처분 전 불량 LOT 에 재검사 회차를 «작성중»으로 만들 수 있었고, 그 회차는 확정할 수 없어(합격·불합격 전이 모두
 *    `from` 밖 → 400) 영영 남았다. 합격·폐기 LOT 도 다시 검사할 대상이 아니다.
 * ⚠ 보류 판정(`HELD`)은 LOT 을 검사 대기로 두므로 그대로 재검사할 수 있다. PQC·OQC 재검사는 지금 동작 그대로다.
 */
export function assertIqcReinspectable(inspectionTypeCode: string, lotStatusCode: string | undefined): void {
  if (inspectionTypeCode !== 'IQC' || lotStatusCode === undefined || lotStatusCode === 'INSPECTION_PENDING') return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message:
        lotStatusCode === 'DEFECTIVE'
          ? '불합격 LOT 은 처분 판정(재작업) 뒤에 재검사할 수 있습니다.'
          : '검사 대기 중인 LOT 만 재검사할 수 있습니다.',
    },
  ]);
}

/** 생산 실적 상태 — 실적은 취소·삭제가 없고 정정도 새 «확정» 행이다(`production-result-correct.service.ts`). */
const PRODUCTION_RESULT_CONFIRMED = 'CONFIRMED';
const DRAFT = 'DRAFT';

/**
 * PQC 결과 쓰기 앞의 판정 두 가지(omf-all-around#107 · 장부 P-49). PQC 가 아니면 아무것도 하지 않는다.
 *
 * 1. **실적이 먼저다**(사용자 결정 2026-10-19 「실적 입력해야 PQC 가 가능한 게 맞다」) — 그 W/O 에 생산 실적이
 *    한 건도 없으면 작성중이든 확정이든 받지 않는다. 실적은 «원본» 행만 센다(`corrects_production_result_id`
 *    가 빈 행 — 정정본은 원본이 있어야 생긴다). 실적에는 취소 상태가 없다.
 * 2. **작성중 1회차를 덮는다** — 오프라인 큐는 서버가 만든 id 를 몰라 `PUT`·`:confirm` 을 못 부르고 늘 `POST` 로
 *    온다. 앞 회차 없이 온 저장인데 그 의뢰의 1회차가 «작성중»이면 409 대신 그 회차를 고친다(확정이면 그 자리에서
 *    확정). 1회차가 이미 확정이면 지금처럼 409 `DUPLICATE_KEY` 다. 고칠 회차의 id 를 돌려준다.
 */
export async function preparePqcWrite(
  prisma: PrismaService,
  body: Pick<InspectionResultCreate, 'inspectionRequestId' | 'previousResultId'>,
  round: number,
): Promise<bigint | null> {
  if (!(await assertPqcAfterProduction(prisma, BigInt(body.inspectionRequestId)))) return null;
  if (body.previousResultId !== undefined || round !== 1) return null;
  const first = await prisma.inspection_result.findFirst({
    where: { inspection_request_id: BigInt(body.inspectionRequestId), inspection_round: 1 },
    select: { inspection_result_id: true, status_code: true },
  });
  return first?.status_code === DRAFT ? first.inspection_result_id : null;
}

/** 위 1번 — `:confirm` 도 같은 판정을 탄다. PQC 의뢰면 `true`(실적이 없으면 400), 아니면 `false`. */
export async function assertPqcAfterProduction(prisma: PrismaService, inspectionRequestId: bigint): Promise<boolean> {
  const request = await prisma.inspection_request.findUnique({
    where: { inspection_request_id: inspectionRequestId },
    select: { inspection_type_code: true, work_order_id: true },
  });
  if (request?.inspection_type_code !== 'PQC') return false;
  const results =
    request.work_order_id === null
      ? 0
      : await prisma.production_result.count({
          where: {
            work_order_id: request.work_order_id,
            status_code: PRODUCTION_RESULT_CONFIRMED,
            corrects_production_result_id: null,
          },
        });
  if (results > 0) return true;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: '이 MES W/O 의 생산 실적이 아직 없습니다. 실적을 먼저 등록하세요.',
    },
  ]);
}

/**
 * IQC 확정의 판정 변경 사유(omf-all-around#125 · 장부 P-70) — 의뢰의 검사기준 버전에 합격판정개수가 있으면
 * 자동 판정과 다른 확정에 사유를 요구한다. 확정 경로 둘(`:confirm`·`POST` 확정)이 같은 함수를 부른다.
 * 기록할 사유(다르게 확정할 때만)를 돌려준다. IQC 가 아니거나 합격판정개수가 없으면 종전 그대로 `undefined`.
 */
export async function assertIqcJudgmentChange(
  prisma: Pick<PrismaService, 'inspection_request'> | Prisma.TransactionClient,
  inspectionRequestId: bigint,
  input: JudgmentQuantities & { judgment: string; reason: string | undefined },
): Promise<string | undefined> {
  const request = await prisma.inspection_request.findUnique({
    where: { inspection_request_id: inspectionRequestId },
    select: { inspection_type_code: true, inspection_plan_version: { select: { acceptance_number: true } } },
  });
  if (request?.inspection_type_code !== 'IQC') return undefined;
  const acceptanceNumber = request.inspection_plan_version?.acceptance_number ?? null;
  return assertJudgmentChangeReason(input, input.judgment, acceptanceNumber, input.reason);
}

/** ⛔ 종합 판정과 항목 판정은 **그룹이 다르다** — 항목에는 「보류」가 없다(§1-5). */
export function assertCodes(
  prisma: PrismaService,
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
  return assertCodeValues(prisma, checks);
}

/**
 * 확정으로 태어나는 저장의 확정 축. ⛔ 주체는 **계정 세션뿐**이다 — `lot_status_event.changed_by`
 * 가 NOT NULL 이고 `X-Worker-No` 가 푸는 `worker_id` 는 그 칸의 축이 아니다(`:confirm` 컨트롤러의
 * `userOf` 와 같은 자리). 오프라인 큐도 로그인 세션으로 온다.
 */
export function bornConfirmed(context: InspectionResultWriteContext): {
  appUserId?: number;
  terminalAudit?: InspectionResultWriteContext['terminalAudit'];
  changedAt: Date;
} {
  if (context.appUserId === undefined && context.terminalAudit === undefined)
    throw new UnauthorizedException('검사 확정 주체가 필요합니다.');
  return { appUserId: context.appUserId, terminalAudit: context.terminalAudit, changedAt: new Date() };
}

/**
 * `uq_inspection_round(의뢰, 회차)` 충돌은 **409 `DUPLICATE_KEY`** 다 — 재시도하지 않는다(§5-1).
 * 회차 채기를 `FOR UPDATE` 로 잠그지 않는 대가다: 잠그면 의뢰 행을 업무 트랜잭션 내내 쥔다.
 */
export function throwRoundConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target ?? '').includes('inspection_round')
  ) {
    throw new ConflictException('user', '같은 의뢰에 같은 회차가 이미 있습니다. 다시 불러온 뒤 저장하세요.', { code: DUPLICATE_KEY });
  }
  throw error;
}
