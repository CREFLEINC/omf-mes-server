import { isPreviousOperation } from './wip-input-rules';

const P10 = 101n;
const P20 = 102n;
const P30 = 103n;
const routing = [
  { operation_seq: 10, process_id: P10 },
  { operation_seq: 20, process_id: P20 },
  { operation_seq: 30, process_id: P30 },
];

describe('반제품 투입 — 바로 앞 공정', () => {
  it('FR-009 — 공정 20 W/O 는 공정 10(P10)의 반제품을 받는다', () => {
    expect(isPreviousOperation(routing, 20, P10)).toBe(true);
  });

  it('FR-009 — 건너뛴 공정은 받지 않는다(공정 30 W/O 에 공정 10 반제품)', () => {
    expect(isPreviousOperation(routing, 30, P10)).toBe(false);
    expect(isPreviousOperation(routing, 30, P20)).toBe(true);
  });

  it('FR-009 — 첫 공정 W/O 는 반제품을 받지 않는다', () => {
    expect(isPreviousOperation(routing, 10, P10)).toBe(false);
  });

  it('FR-009 — 같은 공정 마스터면 다른 Rev 의 반제품도 받는다(순번·Routing 이 아니라 공정 마스터로 비교)', () => {
    // 다른 Rev 에서 공정 10 이 순번 15 로 옮겨 갔어도 바로 앞 공정의 공정 마스터가 같으면 받는다.
    const otherRev = [{ operation_seq: 15, process_id: P10 }, { operation_seq: 20, process_id: P20 }];
    expect(isPreviousOperation(otherRev, 20, P10)).toBe(true);
  });

  it('FR-009 — 바로 앞 공정의 공정 마스터가 다르면 받지 않는다', () => {
    expect(isPreviousOperation(routing, 20, P30)).toBe(false);
  });

  it('FR-009 — 순번 순서와 상관없이 받은 목록에서 바로 앞을 고른다', () => {
    expect(isPreviousOperation([...routing].reverse(), 30, P20)).toBe(true);
  });
});
