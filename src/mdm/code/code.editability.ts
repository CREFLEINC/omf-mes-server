import type { components } from '../../contracts/mdm';

type Editability = components['schemas']['Editability'];

/**
 * 코드그룹·코드값은 **셀 수 없다.** 창고·로케이션에 쓰는 `toEditability` 를 쓰지 않는다.
 *
 * 코드값: `mdm.code_value` 를 FK 로 가리키는 컬럼이 **0개**다. 창고의
 * `warehouse_type_code` 같은 곳에 `'MATERIAL'` 이라는 **글자**가 들어 있을 뿐 연결이
 * 없다. 이런 `*_code` 컬럼이 157개다.
 *
 * 코드그룹: FK 는 `code_value.code_group_id` 하나뿐이라 셀 수는 있지만, 그것은
 * **그룹에 값이 몇 개인지**이지 **그룹 코드 글자를 쓰는 곳이 어딘지**가 아니다.
 * 후자를 쓰는 곳은 `warehouse.validator.ts` 의 `'WAREHOUSE_TYPE'` 같은 소스 문자열이라
 * 셀 수 없다. 셀 수 있는 값이 물어야 할 값의 대리가 되지 않는다.
 *
 * 계약: `NOT_COUNTABLE` → 화면은 무조건 잠근다. `referenceCount` 는 `null`.
 */
export function codeEditability(): Editability {
  return { codeEditable: false, reason: 'NOT_COUNTABLE', referenceCount: null };
}
