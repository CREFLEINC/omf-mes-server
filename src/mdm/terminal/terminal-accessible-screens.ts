/**
 * POP [화면 이동] 후보 — 단말의 공정 매핑 플래그로 화면을 가른다(D3).
 *
 * ⭐ P-10 이 이 자리를 열면서 「생산 등 다른 화면 코드는 **공정 매핑 플래그와 화면 권한의
 * 관계가 별도로 정의될 때까지** 반환하지 않는다」로 `['P-01-01']` 고정을 남겼다. 그 정의가
 * 여기다 — WIP-CHAIN-01 에서 키오스크(주소창 없음)로는 작업 시작·투입·실적으로 갈 길이
 * 아예 없다는 것이 드러났다(D3).
 *
 * ⛔ **계약에 근거가 없다.** 이 오퍼레이션 자체가 설계 사본에 없고(P-10), 화면 코드 ↔ 플래그
 * 대응을 적은 설계 문서도 없다(실측: `plan-uiux.md` U22~U26 은 «슬라이스 ↔ 화면» 표이고
 * 플래그 열이 없다 · 문의 050 이 「`can_return_material` 을 소비하는 화면이 0건」이라 적었다).
 * ⇒ 아래 표는 **서버가 세운 것**이다. 근거는 셋뿐이고 그 밖을 지어내지 않았다:
 *   ⓐ 플래그 이름이 화면의 일과 같은 것(`can_input_result` ↔ 생산 실적)
 *   ⓑ 서버가 실제로 그 플래그로 막는 자리(`can_start_work` ↔ 작업 시작 · `can_print_label`
 *      ↔ 생산 LOT 라벨·개체 발번)
 *   ⓒ 플래그 축이 없는 화면은 **항상** 담는다 — 없는 축으로 막으면 「판정할 수 없음」을
 *      「거부」로 처리하는 것이 된다(공유계약 F-6 의 반대 방향).
 *
 * ⛔ 화면 목록의 정본은 클라이언트 `apps/web/src/patterns/pop-screen-catalog.ts` 다. 진입
 * 화면 `P-CO-01` 은 담지 않는다(그 화면으로 가는 길은 [사용자 전환]이다).
 */

/** `mdm.terminal_process` 의 8플래그 중 화면 판정에 쓰는 이름. */
export type TerminalProcessFlag =
  | 'can_start_work'
  | 'can_input_material'
  | 'can_input_result'
  | 'can_input_inspection'
  | 'can_print_label'
  | 'can_complete_work';

/** 화면 하나가 요구하는 플래그. `null` 이면 축이 없어 «항상» 담는다. */
export interface PopScreenRequirement {
  code: string;
  flag: TerminalProcessFlag | null;
}

/**
 * 화면 ↔ 플래그. 순서는 클라이언트 카탈로그 순서 그대로다 — 목록의 차례가 화면마다 흔들리면
 * 작업자가 버튼 자리를 외울 수 없다.
 */
export const POP_SCREEN_REQUIREMENTS: readonly PopScreenRequirement[] = [
  // ⭐ `P-01-01` 만 「항상」이다(사용자·통합 담당 결정 2026-09-15). P-10 이 이 화면을 연 근거가
  //    「이미 그 **공장** POP 로 자재 LOT·라벨 API 사용이 허용된 화면」이라 **공장 축**이고,
  //    실제로 서버는 자재 LOT 라벨을 공정 플래그로 막지 않는다(`can_print_label` 을 보는 자리는
  //    «생산» LOT 라벨과 개체 발번 둘뿐이다). 공정으로 막으면 화면 목록이 API 보다 엄격해진다.
  { code: 'P-01-01', flag: null },
  { code: 'P-01-02', flag: 'can_print_label' },
  // 작업 시작·중단 — `can_start_work`. 중단(`:hold`·`:resume`)도 같은 축이다:
  // `terminal-production-scope.ts` 의 `ownWorkOrder` 가 그 플래그로 가른다.
  { code: 'P-02-01', flag: 'can_start_work' },
  { code: 'P-02-03', flag: 'can_input_material' },
  { code: 'P-02-04', flag: 'can_input_result' },
  { code: 'P-02-08', flag: 'can_complete_work' },
  { code: 'P-02-09', flag: 'can_print_label' },
  { code: 'P-02-10', flag: 'can_start_work' },
  { code: 'P-02-11', flag: 'can_input_material' },
  // 긴급 W/O 는 플래그 축이 없다 — 긴급은 매핑 밖의 일을 여는 화면이다.
  { code: 'P-02-12', flag: null },
  { code: 'P-02-13', flag: 'can_input_inspection' },
  { code: 'P-04-01', flag: 'can_complete_work' },
  { code: 'P-04-03', flag: 'can_input_result' },
  { code: 'P-04-04', flag: 'can_print_label' },
  // 공구·비가동은 공정 매핑과 무관한 설비 축이다.
  { code: 'P-05-01', flag: null },
  { code: 'P-05-02', flag: null },
];

/** 판정에 들어가는 한 행 — 단말의 공정 하나가 가진 플래그들. */
export type TerminalProcessFlags = Readonly<Record<TerminalProcessFlag, boolean>>;

/**
 * ⭐ **공정 행 중 «하나라도» 참이면 그 화면을 담는다.** 단말에 공정이 여럿 매핑되면 그중
 * 어느 공정으로는 그 일을 할 수 있다는 뜻이고, 화면은 그 안에서 W/O 를 다시 고르기 때문이다.
 * ⛔ 행이 0개인 단말은 축 없는 화면만 받는다 — 「매핑이 없다」를 「무엇이든 된다」로 읽지 않는다.
 */
export function accessibleScreenCodes(rows: readonly TerminalProcessFlags[]): string[] {
  return POP_SCREEN_REQUIREMENTS.filter(
    ({ flag }) => flag === null || rows.some((row) => row[flag] === true),
  ).map(({ code }) => code);
}
