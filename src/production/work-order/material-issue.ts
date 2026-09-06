/**
 * 확정·배포가 곁들여 발행하는 자재 출고요청(§4-3) — production 이 표에 **직접** INSERT 한다.
 * ⭐ 소요식은 `src/core/bom` 으로 올라갔다(I-8.md §7-3 · R-19) — `shortage` 와 **한 함수**다.
 */
export {
  BOM_COMPONENT_SELECT,
  materialRequirements,
  type BomComponentRow,
  type MaterialIssueLine,
} from '../../core/bom';

/** ⛔ 긴급 W/O 만 자동 발행에서 빠진다 — 판정은 서버가 유형으로 한다(계약 G-4). */
const EMERGENCY_TYPE = 'EMERGENCY';

/**
 * ⛔ **판정에 쓰지 않는다** — 컬럼이 NOT NULL 이라 넣을 뿐이다. 값 목록은 계약이 지목한
 * `LOGISTICS_DOCUMENT_STATUS`(시드 4값)이고 정본은 `material-issue-request.constants.ts`
 * 다 — 도메인 간 import 를 안 만들려 값만 복사해 둔다(I-8.md §4-3 · R-11).
 */
export const ISSUE_REGISTERED = 'REGISTERED';

/** 자동 발행 제외. ⛔ `REWORK` 는 대상이 **아니다** — 계약이 `EMERGENCY` 만 적었다. */
export function skipsMaterialIssue(workOrderTypeCode: string): boolean {
  return workOrderTypeCode === EMERGENCY_TYPE;
}
