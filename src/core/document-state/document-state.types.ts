/**
 * 하나의 «상태 칸»을 다스리는 전이. 문서가 아니라 **칸**이 단위다 —
 * `trace.lot` 처럼 한 표가 상태 축을 둘 이상 갖는 자리가 있고, 설계가
 * 「한 필드에 섞지 않는다」로 못 박았다(`02-SW설계사양서` §4.2).
 */
export interface Transition {
  /** 이 상태들에서만 열린다. */
  readonly from: readonly string[];
  readonly to: string;
  /**
   * 이력 표의 `transition_code` 에 그대로 들어가는 값.
   * 없는 전이면 이력에 코드를 남기지 않는다.
   */
  readonly transitionCode?: string;
  /**
   * 이 전이를 여는 계약 오퍼레이션(`METHOD /path`).
   *
   * ⛔ 액션 이름을 계약의 `:cancel` 같은 동사로만 두지 않는 이유가 여기 있다 —
   * **전이를 일으키는 자원과 상태 칸을 가진 자원이 다르다.** W/O 를 취소하면 그
   * W/O 의 선발행 LOT 생명주기가 바뀐다. `cancel` 만으로는 어느 문서의 취소인지 모른다.
   * 그래서 이름은 설명적으로 두고, 계약과의 연결은 이 칸이 진다(검사가 실재를 확인한다).
   */
  readonly sourceOperation: string;
}

/** `스키마.표.컬럼` — 상태 칸을 가리킨다. */
export type StateColumn = string;
/** 계약의 액션 이름(`:cancel` 의 `cancel`) 또는 그에 준하는 업무 사건. */
export type ActionName = string;

export type TransitionRegistry = Readonly<
  Record<StateColumn, Readonly<Record<ActionName, Transition>>>
>;
