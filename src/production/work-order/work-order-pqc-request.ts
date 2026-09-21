import { Prisma } from '@prisma/client';

import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import type { Tx } from '../../core/lot';

/**
 * W/O 배포 시 **PQC(공정검사) 검사 의뢰**를 만든다 — 설계 REQ-OA-0003(2026-07-15)이
 * 「PQC 는 Routing 의 검사 공정 명시 기반 opt-in 이고, 샘플이면 W/O 전개 시 배정한다」로
 * 확정했다. 그전까지 PQC 의뢰를 만드는 코드가 서버에 하나도 없어 P-02-13(POP 제품 검사)이
 * 열릴 대상이 없었다(omf-all-around#46).
 *
 * ⭐ **대상은 작업지시 하나다**(`target_type_code = 'WORK_ORDER'`). 계약이 그 enum 값을
 *    「작업지시(PQC)」로 적어 두었고, 화면도 작업지시로 들어온다. 어느 생산 LOT 을 뽑아
 *    검사할지(샘플 «배정»)는 이 자리에서 정하지 않는다 — 배포 시점의 생산 LOT 은 아직
 *    선발행 껍데기라 「무엇을 검사했나」를 그 번호로 말할 수 없다. 샘플이 정하는 것은
 *    여기서는 **검사 수량**뿐이고, LOT 배정은 후속이다(#46 §3 — 완료 조건은 의뢰 생성까지).
 *
 * ⛔ **기준이 없다고 배포를 막지 않는다.** IQC·OQC 는 기준이 정확히 하나가 아니면 400 으로
 *    막지만(`core/quality/inspection-plan-version`), 배포는 훨씬 자주 도는 액션이라 같은
 *    규칙을 쓰면 기준 미등록 품목의 생산이 통째로 선다. 계약도 PQC 의뢰의
 *    `inspectionPlanVersionId` 가 비는 것을 허용한다(「IQC·OQC 는 언제나 채워 내린다」).
 *    ⇒ 기준을 못 고르면 **비운 채로 의뢰를 만든다.** 검사 항목·판정 기준은 검사 화면이
 *    의뢰에 달린 기준으로 읽으므로, 비어 있으면 그 화면이 말한다.
 */

/** 검사 기준 버전에서 이 의뢰가 쓰는 값만. 기준을 못 고르면 `null`. */
interface PqcPlanVersion {
  inspectionPlanVersionId: bigint;
  samplingMethodCode: string;
  /** **백분율**이다(0 초과 100 이하) — 비율이 아니다. */
  samplingRatio: Prisma.Decimal | null;
}

/** 트랜잭션을 열기 전에 다 정해 두는 값 — 트랜잭션 안은 쓰기만 한다(배포 §4-1 규율). */
export interface PqcRequestPlan {
  requestNo: string;
  inspectionPlanVersionId: bigint | null;
  targetQty: Prisma.Decimal;
}

/** 전수검사 — 지시수량을 그대로 검사한다. */
const FULL_INSPECTION = 'FULL_INSPECTION';

/**
 * 이 공정에 유효한 PQC 기준 버전.
 *
 * ⚠ IQC·OQC 의 `resolveInspectionPlanVersion` 과 조회 축이 다르다 — PQC 기준은 품목뿐
 *   아니라 **공정·라우팅**으로도 걸린다(`inspection_plan.process_id`·`routing_id`). 그래서
 *   그 함수를 쓰지 않고 여기서 따로 고른다. 여러 건이면 좁은 쪽(공정 지정)이 이긴다 —
 *   품목 전체 기준과 공정별 기준이 함께 있으면 공정별이 그 공정의 답이다.
 */
async function resolvePqcPlanVersion(
  prisma: PrismaService,
  itemId: bigint,
  processId: bigint,
  routingId: bigint,
  effectiveDate: Date,
): Promise<PqcPlanVersion | null> {
  const versions = await prisma.inspection_plan_version.findMany({
    where: {
      status_code: 'CONFIRMED',
      effective_from: { lte: effectiveDate },
      OR: [{ effective_to: null }, { effective_to: { gte: effectiveDate } }],
      inspection_plan: {
        inspection_type_code: 'PQC',
        is_active: true,
        item_id: itemId,
        OR: [{ process_id: processId }, { routing_id: routingId }, { process_id: null, routing_id: null }],
      },
    },
    select: {
      inspection_plan_version_id: true,
      sampling_method_code: true,
      sampling_ratio: true,
      inspection_plan: { select: { process_id: true, routing_id: true } },
    },
  });
  if (versions.length === 0) return null;

  /* 공정·라우팅을 지정한 기준이 품목 전체 기준을 이긴다 — 둘 다 「이 공정의 답」을 적은 것이다. */
  const scoped = versions.filter(
    (version) =>
      version.inspection_plan.process_id !== null || version.inspection_plan.routing_id !== null,
  );
  const candidates = scoped.length > 0 ? scoped : versions;
  /* 좁힌 뒤에도 둘 이상이면 고르지 않는다 — 임의로 고르면 어느 기준으로 검사했는지가 기록에서 사라진다. */
  if (candidates.length !== 1) return null;

  const [only] = candidates;
  return {
    inspectionPlanVersionId: only.inspection_plan_version_id,
    samplingMethodCode: only.sampling_method_code,
    samplingRatio: only.sampling_ratio,
  };
}

/**
 * 검사 수량 — 전수면 지시수량, 샘플이면 **비율(%)로 줄인 수**다.
 *
 * ⛔ **`sampling_ratio` 는 비율(0~1)이 아니라 백분율(0 초과 100 이하)이다**(마이그
 *    `20260903800000_inspection_sampling_ratio_percent` · 계약 「샘플 비율(%)」 · 확정 2026-07-15).
 *    같은 숫자가 두 뜻을 갖는 자리라 조용히 틀린다 — 10 을 비율로 읽으면 지시수량의 **열 배**가
 *    검사 대상이 되고, 발행된 의뢰를 지울 경로는 계약에 없다.
 *
 * ⚠ 올림한다. 3.5% 로 지시가 100 이면 3.5 인데, 검사는 개수라 4 로 올려야 기준을 밑돌지 않는다.
 *
 * ⛔ **`sampling_qty` 는 보지 않는다.** 계약에 그 칸이 없고(「수량은 파생값이라 두지 않는다」 A-8)
 *    쓰기 경로도 없어 언제나 비어 있다 — 안 타는 분기를 규칙처럼 두면 다음 사람이 그것을 정본으로 읽는다.
 */
function inspectionQty(orderQty: Prisma.Decimal, version: PqcPlanVersion | null): Prisma.Decimal {
  if (version === null || version.samplingMethodCode === FULL_INSPECTION) return orderQty;
  if (version.samplingRatio === null) return orderQty;

  const sampled = orderQty.mul(version.samplingRatio).div(100).ceil();
  /* 비율이 아무리 작아도 한 개는 검사한다 — 0 건짜리 의뢰는 열 수 없다. */
  return sampled.lessThan(1) ? new Prisma.Decimal(1) : sampled;
}

/**
 * 배포 전 준비 — 검사 공정이 아니면 `null`(의뢰를 만들지 않는다).
 *
 * ⛔ 채번·기준 조회는 `$transaction` **밖**이다. 안에서 부르면 한 요청이 커넥션을 둘 쥐어
 *    `P2024` 로 죽는다(출하 OQC 선례와 같은 규율).
 */
export async function preparePqcRequest(
  prisma: PrismaService,
  numbering: NumberingService,
  input: {
    inspectionManaged: boolean;
    itemId: bigint;
    processId: bigint;
    routingId: bigint;
    orderQty: Prisma.Decimal;
    businessDate: string;
  },
): Promise<PqcRequestPlan | null> {
  if (!input.inspectionManaged) return null;

  const version = await resolvePqcPlanVersion(
    prisma,
    input.itemId,
    input.processId,
    input.routingId,
    new Date(input.businessDate),
  );
  const requestNo = await numbering.next('INSPECTION_REQUEST', null, input.businessDate);

  return {
    requestNo,
    inspectionPlanVersionId: version?.inspectionPlanVersionId ?? null,
    targetQty: inspectionQty(input.orderQty, version),
  };
}

/**
 * 트랜잭션 안 쓰기.
 *
 * ⛔ **같은 W/O 에 살아 있는 PQC 의뢰가 있으면 또 만들지 않는다.** 물리 유니크는 IQC 전용
 *    부분 인덱스뿐이라(`uq_iqc_inspection_request_lot`) 여기는 서버가 지킨다 — 취소 후
 *    재배포처럼 배포가 두 번 도는 길이 있고, 그때 의뢰가 둘이면 현장이 무엇을 검사해야 하는지
 *    알 수 없다(출하 OQC 가 같은 이유로 같은 방식을 쓴다).
 */
export async function writePqcRequest(
  tx: Tx,
  input: {
    workOrderId: number;
    itemId: bigint;
    uomId: bigint;
    plan: PqcRequestPlan;
  },
  appUserId: number,
): Promise<void> {
  const existing = await tx.inspection_request.findFirst({
    where: {
      work_order_id: BigInt(input.workOrderId),
      inspection_type_code: 'PQC',
      status_code: { in: ['REQUESTED', 'IN_PROGRESS'] },
    },
    select: { inspection_request_id: true },
  });
  if (existing !== null) return;

  await tx.inspection_request.create({
    data: {
      inspection_request_no: input.plan.requestNo,
      inspection_type_code: 'PQC',
      inspection_plan_version_id: input.plan.inspectionPlanVersionId,
      target_type_code: 'WORK_ORDER',
      target_id: BigInt(input.workOrderId),
      item_id: input.itemId,
      /* ⚠ 공정검사는 실적 «전»에 한다 — 의뢰를 만드는 지금은 검사할 LOT 도 실적도 없다(계약). */
      lot_id: null,
      work_order_id: BigInt(input.workOrderId),
      target_qty: input.plan.targetQty,
      uom_id: input.uomId,
      status_code: 'REQUESTED',
      requested_at: new Date(),
      created_by: appUserId,
    },
  });
}
