import { ErrorCode, ErrorItem, fieldError } from '../common/errors/contract-error';

/**
 * **컬렉션 전체 치환**(공유계약 B-6)이 공통으로 하는 검증.
 *
 * 품목 부속 3종과 작업자 자격이 같은 형태다 — 최종 상태를 통째로 받아 한 트랜잭션으로
 * 지우고 넣는다. 마스터마다 베끼면 유일키를 접는 방식이나 오류 필드 모양이 갈라진다.
 */

/** 몇 번째 행이 문제인지 알려준다 — 목록을 통째로 보내므로 필드 이름만으로는 못 찾는다. */
export function rowError(index: number, field: string, message: string): ErrorItem {
  return fieldError(`[${index}].${field}`, ErrorCode.RANGE, message);
}

/**
 * `2026-08-07` 형태라 문자열 비교로 충분하다 — 자릿수가 고정이다.
 * DTO 가 형태를 이미 막았으므로 여기서는 앞뒤만 본다.
 */
export function checkDateRange(
  index: number,
  from: string,
  to: string | null | undefined,
  field: string,
): ErrorItem[] {
  if (!to) return [];

  return to >= from ? [] : [rowError(index, field, '종료일이 시작일보다 앞설 수 없습니다.')];
}

/**
 * 보낸 목록 안의 중복. DB 유일 제약에 맡기면 **트랜잭션 한복판에서 터지고** 어느 행이
 * 문제인지 알려주기 어렵다.
 *
 * `key` 를 만들 때 `?? 0` 으로 접는 축이 있다 — `COALESCE(partner_id, 0)` 처럼 DB 가
 * 접는 유일키를 서버도 같게 흉내 내야 한다(공유계약 A-7). 안 접으면 검사를 빠져나간다.
 */
export function findDuplicates<T>(
  rows: T[],
  key: (row: T) => string,
  field: string,
): ErrorItem[] {
  const seen = new Map<string, number>();
  const errors: ErrorItem[] = [];

  rows.forEach((row, index) => {
    const value = key(row);
    const first = seen.get(value);

    if (first === undefined) {
      seen.set(value, index);
    } else {
      errors.push(rowError(index, field, `${first} 번째 행과 중복됩니다.`));
    }
  });

  return errors;
}
