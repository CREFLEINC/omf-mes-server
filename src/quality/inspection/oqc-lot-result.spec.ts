import { OqcLotFacts, OqcResultFacts, oqcLotStatuses } from './oqc-lot-result';

/** 피처 010 OQC LOT 판정(data-model 「LOT OQC 판정」) — 위에서부터 처음 맞는 값. */
const lot = (lotId: number, inspectionRequired = true): OqcLotFacts => ({ lotId: BigInt(lotId), inspectionRequired });
const result = (seqNo: number, judgmentCode: string | null, lotIds: number[], statusCode = 'DRAFT', requestId = 1): OqcResultFacts => ({
  requestId: BigInt(requestId), seqNo, judgmentCode, statusCode, lotIds: lotIds.map(BigInt),
});
const statusesOf = (lots: OqcLotFacts[], results: OqcResultFacts[], skipped = false) =>
  Object.fromEntries([...oqcLotStatuses(lots, { skipped, results })].map(([lotId, status]) => [Number(lotId), status]));

describe('oqcLotStatuses — LOT 마다 마지막 매칭 결과의 판정', () => {
  it('US3-2 결과 1(LOT 1·2 합격)·결과 2(LOT 3 불합격) → LOT 1·2 합격, LOT 3 불합격', () => {
    expect(statusesOf([lot(1), lot(2), lot(3)], [result(1, 'ACCEPTED', [1, 2]), result(2, 'REJECTED', [3])]))
      .toEqual({ 1: 'ACCEPTED', 2: 'ACCEPTED', 3: 'REJECTED' });
  });

  it('US3-3·US3-4 같은 LOT 의 순번 최대 결과가 판정이다 — 불합격 뒤 재검 합격이면 합격', () => {
    expect(statusesOf([lot(3)], [result(2, 'ACCEPTED', [3]), result(1, 'REJECTED', [3])])).toEqual({ 3: 'ACCEPTED' });
    expect(statusesOf([lot(3)], [result(1, 'ACCEPTED', [3]), result(2, 'HELD', [3])])).toEqual({ 3: 'HELD' });
  });

  it('US3-6·FR-011 매칭 결과가 없는 LOT 은 미검사다 — 다른 지시서의 합격은 결과 모집단에 없다', () => {
    expect(statusesOf([lot(1), lot(4)], [result(1, 'ACCEPTED', [1])])).toEqual({ 1: 'ACCEPTED', 4: 'NOT_INSPECTED' });
  });

  it('판정이 빈 결과는 판정을 주지 않는다(미검사)', () => {
    expect(statusesOf([lot(1)], [result(1, null, [1])])).toEqual({ 1: 'NOT_INSPECTED' });
  });

  it('검사 불필요 라인의 LOT 은 NOT_REQUIRED, 생략된 의뢰는 SKIPPED(통과)', () => {
    expect(statusesOf([lot(1, false)], [result(1, 'REJECTED', [1])])).toEqual({ 1: 'NOT_REQUIRED' });
    expect(statusesOf([lot(1), lot(2)], [], true)).toEqual({ 1: 'SKIPPED', 2: 'SKIPPED' });
  });

  it('배포 전 확정 결과(매칭 행 없음)는 그 품목 피킹 LOT 전부를 매칭한 것으로 본다 — 작성중 결과는 아니다', () => {
    expect(statusesOf([lot(1), lot(2)], [result(1, 'ACCEPTED', [], 'CONFIRMED')])).toEqual({ 1: 'ACCEPTED', 2: 'ACCEPTED' });
    expect(statusesOf([lot(1)], [result(1, 'ACCEPTED', [], 'DRAFT')])).toEqual({ 1: 'NOT_INSPECTED' });
    // 그 뒤 새 결과가 LOT 하나를 덮으면 그 LOT 만 바뀐다.
    expect(statusesOf([lot(1), lot(2)], [result(1, 'ACCEPTED', [], 'CONFIRMED'), result(2, 'REJECTED', [2])]))
      .toEqual({ 1: 'ACCEPTED', 2: 'REJECTED' });
  });

  it('US3-5 교체된 LOT 은 모집단(살아 있는 피킹 LOT)에 없으니 판정 맵에도 없다', () => {
    expect(statusesOf([lot(1)], [result(1, 'REJECTED', [1, 9])])).toEqual({ 1: 'REJECTED' });
  });

  it('의뢰가 둘이면 의뢰 순서 → 순번으로 «마지막»을 고른다', () => {
    expect(statusesOf([lot(1)], [result(5, 'REJECTED', [1], 'DRAFT', 1), result(1, 'ACCEPTED', [1], 'DRAFT', 2)]))
      .toEqual({ 1: 'ACCEPTED' });
  });
});
