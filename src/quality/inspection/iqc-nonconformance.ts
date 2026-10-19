import { Prisma } from '@prisma/client';

import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * IQC 불합격 → 부적합 자동 등록(omf-all-around#106 후속 · 2026-10-16 결정 (다) · 장부 P-41).
 *
 * 불합격 LOT 은 `DEFECTIVE` 로 굳고(C6) 확정 전이로는 되돌아오지 않는다(문의 088 — 열지 않기로 했다).
 * 다음 처리(재작업·재검 C17 → 재검 합격 C4 · 폐기 C18 · 정상 C19 · 선별)는 **처분 판정**(W-03-10)이 하고,
 * 그 판정은 부적합이 있어야 선다. 부적합을 만드는 화면(W-04-07)은 반품·OQC 만 후보로 보여 IQC LOT 이
 * 닿을 길이 없었다 — 그래서 불합격 확정이 «그 자리에서» 부적합을 세운다.
 *
 * ⭐ 상태는 `PENDING_DECISION`(처분 대기)로 바로 선다 — 불합격 확정이 곧 처분 의뢰다. 등록 화면을 거쳐
 *    `:request-disposition` 을 한 번 더 누르게 하면 그 사이 LOT 이 처분 판정 목록에 안 보인다.
 * ⛔ 번호는 트랜잭션 «밖»에서 받는다(채번 규약) — `allocateIqcNonconformanceNo`.
 * ⛔ 이미 열린 부적합이 있는 LOT 이면 새로 만들지 않는다 — 수동 등록(W-04-07)과 같은 «LOT 당 열린 부적합 하나».
 */

const NONCONFORMANCE = 'NONCONFORMANCE';
const IQC = 'IQC';
const REJECTED = 'REJECTED';
const PENDING_DECISION = 'PENDING_DECISION';
/** 시드 `NONCONFORMANCE_SEVERITY` — 수입검사 불합격의 기본 심각도. 처분 화면에서 사람이 판단한다. */
const DEFAULT_SEVERITY = 'MAJOR';
const DEFECTIVE = 'DEFECTIVE';

export interface IqcNonconformanceTarget {
  inspection_type_code: string;
  lot_id: bigint | null;
  item_id: bigint;
  uom_id: bigint;
  work_order_id: bigint | null;
}

export const needsIqcNonconformance = (type: string, judgment: string | undefined, lotId: bigint | null): boolean =>
  type === IQC && judgment === REJECTED && lotId !== null;

/** 확정 «전»에 번호를 받는다 — IQC 불합격이 아니면 `undefined`(번호를 태우지 않는다). */
export async function allocateIqcNonconformanceNo(
  prisma: PrismaService,
  numbering: NumberingService,
  inspectionRequestId: bigint,
  judgment: string | undefined,
  at: Date,
): Promise<string | undefined> {
  if (judgment !== REJECTED) return undefined;
  const request = await prisma.inspection_request.findUnique({
    where: { inspection_request_id: inspectionRequestId },
    select: { inspection_type_code: true, lot_id: true },
  });
  if (request === null || !needsIqcNonconformance(request.inspection_type_code, judgment, request.lot_id)) return undefined;
  return numbering.next(NONCONFORMANCE, null, at.toISOString().slice(0, 10));
}

/**
 * 불합격 확정과 «같은 트랜잭션»에서 부적합 1건 + 대상 LOT 1줄을 세운다. 수량은 불합격 수량(0 이면 검사 수량 —
 * 전량 판정), 설명은 불량 기록의 사유를 잇는다. 돌려주는 값은 만든 부적합 id(만들지 않았으면 `null`).
 */
export async function createIqcNonconformanceWithin(
  tx: Prisma.TransactionClient,
  input: {
    nonconformanceNo: string;
    inspectionResultId: bigint;
    request: IqcNonconformanceTarget;
    qty: number;
    appUserId: number | undefined;
    at: Date;
  },
): Promise<bigint | null> {
  const lotId = input.request.lot_id;
  if (lotId === null) return null;
  const open = await tx.nonconformance_lot.findFirst({
    where: { lot_id: lotId, nonconformance: { closed_at: null } },
    select: { nonconformance_id: true },
  });
  if (open !== null) return null;

  const reasons = await tx.defect_record.findMany({
    where: { inspection_result_id: input.inspectionResultId },
    orderBy: { defect_record_id: 'asc' },
    select: { defect_description: true, defect_code: { select: { defect_code: true, defect_name: true } } },
  });
  const description =
    reasons.length === 0
      ? '수입검사 불합격'
      : `수입검사 불합격 — ${reasons
          .map((reason) =>
            [`${reason.defect_code.defect_code} ${reason.defect_code.defect_name}`, reason.defect_description]
              .filter((part) => part !== null && part !== '')
              .join(': '),
          )
          .join(' / ')}`;
  const by = input.appUserId === undefined ? null : BigInt(input.appUserId);

  const created = await tx.nonconformance.create({
    data: {
      nonconformance_no: input.nonconformanceNo,
      item_id: input.request.item_id,
      work_order_id: input.request.work_order_id,
      inspection_result_id: input.inspectionResultId,
      severity_code: DEFAULT_SEVERITY,
      description,
      status_code: PENDING_DECISION,
      opened_at: input.at,
      created_by: by,
      updated_by: by,
    },
    select: { nonconformance_id: true },
  });
  await tx.nonconformance_lot.create({
    data: {
      nonconformance_id: created.nonconformance_id,
      lot_id: lotId,
      affected_qty: new Prisma.Decimal(input.qty),
      uom_id: input.request.uom_id,
      // 불합격 확정(C6)이 «방금» 옮긴 상태다 — 등록이 LOT 을 옮기지 않으므로 앞뒤가 같다.
      quality_status_before_code: DEFECTIVE,
      quality_status_after_code: DEFECTIVE,
      created_by: by,
    },
  });
  return created.nonconformance_id;
}
