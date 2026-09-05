/**
 * 값이 없으면 «키를 생략»한다. 널을 내리면 계약의 「선택 필드」와 뜻이 갈린다
 * (예: `ApprovalRouteStep.approverName` — 비-USER 행은 키 자체가 없다).
 */
export const omitEmpty = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
