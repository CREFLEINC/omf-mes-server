import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';

/**
 * `inspection-results` 목록 — `inspectionRequestId` 도 기간도 없으면 400(계약 `:753`).
 * ⭐ R-17 — `summary`·`defect-rate-trend`(PR ⑤)의 「기간 무조건 필수」와 «다르다». 공용
 * 헬퍼로 뭉치면 `summary?inspectionRequestId=…` 가 조용히 200 을 낸다 — 이 함수는 이 목록 전용이다.
 */
export function assertScopedOrPeriod(query: {
  inspectionRequestId?: number;
  inspectedFrom?: string;
  inspectedTo?: string;
}): void {
  assertPeriodPair(query);
  if (query.inspectionRequestId !== undefined) return;
  if (query.inspectedFrom !== undefined) return; // 위에서 쌍임을 확인했으니 하나만 봐도 된다
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('inspectionRequestId', ERROR_CODE.REQUIRED, 'inspectionRequestId 또는 기간(inspectedFrom·inspectedTo) 중 하나가 필요합니다.'),
  ]);
}

/**
 * ⭐ R-17 — 집계 3건의 기간은 **무조건 필수**다(계약 `:1157`·`:1055` 의 `inspectedFrom` 설명
 * 「필수 — 공유계약 L-3」). 목록과 규칙이 «다르므로» 함수도 둘이다 — 위 함수를 재사용하지 않는다.
 */
export function assertPeriodRequired(query: { inspectedFrom?: string; inspectedTo?: string }): void {
  assertPeriodPair(query);
  if (query.inspectedFrom === undefined) {
    throw one(field('inspectedFrom', ERROR_CODE.REQUIRED, '기간(inspectedFrom·inspectedTo)이 필요합니다.'));
  }
}

/**
 * ⭐ #298 m-3 — 의뢰별 **최종 회차 1건**만 남긴다(§4-2 의 그룹 정의 그대로). 옛 구현은
 * `groupBy` 로 그룹을 «전건» 뽑고 그 수만큼 `(의뢰, 회차)` AND 절을 OR 로 폈다 — 스코프가
 * 넓어질수록 OR 가 그대로 늘었다. 좁은 칸 셋만 읽어 메모리에서 접으면 뒤 질의가 id `in` 하나다.
 */
export function finalRoundOf<T extends { inspection_request_id: bigint; inspection_round: number }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = row.inspection_request_id.toString();
    const kept = best.get(key);
    if (kept === undefined || row.inspection_round > kept.inspection_round) best.set(key, row);
  }
  return [...best.values()];
}

/** 계약 `inspectedTo` 설명 — inspectedFrom 과 한 쌍. 한쪽만 오면 400 PAIR(L-3 하한 없는 구멍 방지). */
export function assertPeriodPair(query: { inspectedFrom?: string; inspectedTo?: string }): void {
  if ((query.inspectedFrom !== undefined) === (query.inspectedTo !== undefined)) return;
  throw one(field('inspectedTo', ERROR_CODE.PAIR, 'inspectedFrom·inspectedTo 는 함께 보내거나 함께 생략한다.'));
}

/** 정렬 허용 3키(계약 `:859-861`). 동률은 `inspection_result_id` 로 닫는다. */
const SORT_KEYS = ['inspectionRequestNo', 'inspectedAt', 'rejectedQty'] as const;
type InspectionResultSortKey = (typeof SORT_KEYS)[number];

function orderByField(
  key: InspectionResultSortKey,
  direction: 'asc' | 'desc',
): Prisma.inspection_resultOrderByWithRelationInput {
  if (key === 'inspectionRequestNo') return { inspection_request: { inspection_request_no: direction } };
  if (key === 'inspectedAt') return { inspected_at: direction };
  return { rejected_qty: direction };
}

/**
 * `"키,asc|desc"` — 기본 `inspectedAt,desc`(계약). 허용 키·방향 밖은 400 `INVALID`(work-order
 * 정렬 화이트리스트 선례). ⭐ §4-2 — 이 순서는 **뿌리(1회차)** 사이의 순서다. 사슬 안은 항상
 * `inspection_round asc` — 이 함수가 관여하지 않는다.
 */
export function buildInspectionResultOrderBy(sort?: string): Prisma.inspection_resultOrderByWithRelationInput[] {
  const [rawKey, rawDirection] = (sort ?? 'inspectedAt,desc').split(',');
  const key = SORT_KEYS.find((candidate) => candidate === rawKey);
  const direction = rawDirection === undefined ? 'asc' : rawDirection;
  if (key === undefined || (direction !== 'asc' && direction !== 'desc')) {
    throw one(field('sort', ERROR_CODE.INVALID, `${SORT_KEYS.join(' · ')} 중 하나이고 asc·desc 만 받는다.`));
  }
  return [orderByField(key, direction), { inspection_result_id: 'asc' }];
}

/** 확정 상태값. 전이표(`quality.inspection_result.status_code`)와 물리 CHECK 둘이 같은 문자열을 쓴다. */
export const CONFIRMED = 'CONFIRMED';
/** `Decimal(20, 6)` — 물리 자릿수까지 정수로 옮겨 센다. 부동소수 합으로 재면 DB CHECK 와 판정이 갈린다. */
const QTY_SCALE = 1_000_000;

/** 계약 `InspectionResultCreate` 의 수량·판정 세 칸(자릿수는 §1-3). */
export interface InspectionResultQuantities {
  statusCode: string;
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  heldQty: number;
  overallJudgmentCode?: string;
}

/**
 * 확정 행이 지켜야 하는 둘 — 계약 `InspectionResultCreate` 설명 두 문장 그대로
 * (「⛔ statusCode=확정 이면 합이 같아야 한다 … **작성중은 통과시킨다**」 · 「statusCode=확정
 * 이면 필수다」). ⛔ 작성중(DRAFT)에는 걸지 않는다 — M-e ⓑ·ⓒ 가 물리를 그 모양으로 풀었다.
 *
 * ⭐ 사용자에게 보이는 400 은 **여기가 낸다.** 물리 CHECK 둘(`ck_inspection_result_qty`·
 * `ck_inspection_result_judgment`)은 그 아래 둘째 그물이고, 거기까지 가면 500 이다
 * (`prisma-error.ts:23` — CHECK 위반은 공용 그물에 안 걸린다).
 */
export function assertConfirmedShape(body: InspectionResultQuantities): void {
  if (body.statusCode !== CONFIRMED) return;
  const errors: ErrorItem[] = [];
  if (body.overallJudgmentCode === undefined) {
    errors.push(field('overallJudgmentCode', ERROR_CODE.REQUIRED, '확정에는 종합 판정이 필요합니다.'));
  }
  const scaled = (value: number): number => Math.round(value * QTY_SCALE);
  if (scaled(body.acceptedQty) + scaled(body.rejectedQty) + scaled(body.heldQty) !== scaled(body.inspectedQty)) {
    errors.push(field('inspectedQty', ERROR_CODE.INVALID, '합격·불합격·보류 수량의 합이 검사 수량과 같아야 합니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/**
 * `ck_measurement_single_value`(`num_nonnulls(...) <= 1`)를 손으로 앞당겨 잡는다. 계약은 값 세 칸을
 * 각각 선택으로만 적어 스키마 검증이 「둘 다 채움」을 통과시키는데, 그대로 흘리면 CHECK 위반이 500 이다.
 * ⚠ 전부 비는 것은 통과다 — 「미측정」 갈래다(§1-3).
 */
export function assertMeasurementValues(
  measurements: readonly { numericValue?: number; textValue?: string; booleanValue?: boolean }[] | undefined,
): void {
  const errors = (measurements ?? []).flatMap((measurement, index) =>
    [measurement.numericValue, measurement.textValue, measurement.booleanValue].filter((value) => value !== undefined).length > 1
      ? [field(`measurements[${index}]`, ERROR_CODE.INVALID, '숫자·문자·불리언 중 한 칸만 채웁니다.')]
      : [],
  );
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/**
 * 물리 하한을 손으로 앞당겨 잡는다 — CHECK·도메인 위반은 공용 그물에 안 걸려 **500** 이다
 * (`prisma-error.ts:23` 「CHECK 위반은 여기 오지 않는다」). 라이브 DB `pg_constraint` 실측:
 *
 *   inspection_result_inspected_qty_check    CHECK (inspected_qty > 0)   ← **조건이 없다**
 *   도메인 app.qty_t                          CHECK (VALUE >= 0)          ← 수량 네 칸 전부
 *   inspection_measurement_sample_no_check   CHECK (sample_no > 0)
 *
 * ⚠ M-e ⓑ 가 조건부로 푼 것은 **합계** CHECK(`ck_inspection_result_qty`) 하나뿐이라 이 하한들은
 *   작성중(DRAFT)에도 그대로 산다. 그리고 「세 칸을 다 채우기 전 임시 저장」이 정확히 이 갈래라
 *   **가장자리가 아니라 본길**이다 — M-e ⓑ 의 존재 이유가 곧 이 요청이다.
 * ⛔ 계약에 `minimum` 이 0건이라 계약 검증 가드도 못 막는다 — 서비스가 유일한 그물이다.
 * ⛔ 새 `ERROR_CODE` 를 만들지 않는다. `RANGE` 는 형제 수량 그물이 쓰는 값이다
 *   (`material-consumption.service.ts:269,274` · `lot.service.ts:258` · `material-return.service.ts:182`).
 */
export function assertQuantityBounds(body: {
  inspectedQty?: number;
  acceptedQty?: number;
  rejectedQty?: number;
  heldQty?: number;
  measurements?: readonly { sampleNo: number }[];
}): void {
  const errors: ErrorItem[] = [];
  if (body.inspectedQty !== undefined && !(body.inspectedQty > 0)) {
    errors.push(field('inspectedQty', ERROR_CODE.RANGE, '검사 수량은 0 보다 커야 합니다.'));
  }
  for (const name of ['acceptedQty', 'rejectedQty', 'heldQty'] as const) {
    const value = body[name];
    if (value !== undefined && !(value >= 0)) {
      errors.push(field(name, ERROR_CODE.RANGE, '0 보다 작을 수 없습니다.'));
    }
  }
  (body.measurements ?? []).forEach((measurement, index) => {
    if (!(measurement.sampleNo > 0)) {
      errors.push(field(`measurements[${index}].sampleNo`, ERROR_CODE.RANGE, '표본 번호는 0 보다 커야 합니다.'));
    }
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
