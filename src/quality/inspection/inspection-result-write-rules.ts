import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { CodeCheck, assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InspectionMeasurementInput,
  InspectionResultCreate,
  InspectionResultWriteContext,
} from './inspection-result-write-input';

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
export async function resolveInspector(
  prisma: PrismaService,
  context: InspectionResultWriteContext,
): Promise<bigint> {
  const workerNo = context.workerNo;
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
    select: { inspection_request_id: true, version_no: true },
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
  const max = await prisma.inspection_result.aggregate({
    where: { inspection_request_id: request.inspection_request_id },
    _max: { inspection_round: true },
  });
  return (max._max.inspection_round ?? 0) + 1;
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
