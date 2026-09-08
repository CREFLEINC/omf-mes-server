import { ContractException, ErrorItem } from '../../common/errors';
import { LotExternalIdentifierUpsert, assertNoDuplicate } from './lot-external-identifier.service';

function item(overrides: Partial<LotExternalIdentifierUpsert> = {}): LotExternalIdentifierUpsert {
  return { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: 'SL-1', ...overrides };
}

/** 400 본문의 첫 항목 — 코드·필드·유일키 범위를 함께 본다. */
function rejected(items: LotExternalIdentifierUpsert[]): ErrorItem {
  try {
    assertNoDuplicate(items);
  } catch (error) {
    return (error as ContractException).errors[0];
  }
  throw new Error('중복을 막지 못했다');
}

describe('LOT 외부 식별자 — 요청 안 중복 (I-18 PR ②)', () => {
  it('⭐ 5칸이 모두 같은 두 행은 400 UNIQUE_VIOLATION 이다 — 표현식 인덱스라 DB 는 500 을 낸다', () => {
    expect(rejected([item(), item()])).toMatchObject({
      scope: 'field',
      // 뒤에 실린 행을 짚는다 — 화면이 어느 줄을 고쳐야 하는지 알아야 한다.
      field: 'items.1.externalIdentifier',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: [
        'lotId',
        'identifierTypeCode',
        'partnerId',
        'externalSystemCode',
        'externalIdentifier',
      ],
    });
  });

  it('⭐ partnerId 만 다른 두 행은 통과한다 — COALESCE(partner_id,0) 도 유일키의 한 칸이다', () => {
    expect(() =>
      assertNoDuplicate([item({ partnerId: 1 }), item({ partnerId: 2 })]),
    ).not.toThrow();
  });

  it('⛔ 널과 「빈 값」은 같은 칸이다 — partnerId 널↔0 · externalSystemCode 널↔빈 문자열', () => {
    expect(rejected([item({ partnerId: null }), item({ partnerId: 0 })])).toMatchObject({
      code: 'UNIQUE_VIOLATION',
      field: 'items.1.externalIdentifier',
    });
    expect(
      rejected([item({ externalSystemCode: null }), item({ externalSystemCode: '' })]),
    ).toMatchObject({ code: 'UNIQUE_VIOLATION' });
  });

  it('⭐ 0행 요청은 통과한다 — 전건 삭제가 계약이 말한 「빠진 행은 삭제한다」의 극단이다', () => {
    expect(() => assertNoDuplicate([])).not.toThrow();
    // 유형이 다르면 같은 식별자 문자열이라도 다른 행이다.
    expect(() =>
      assertNoDuplicate([item(), item({ identifierTypeCode: 'ERP_LOT' })]),
    ).not.toThrow();
  });
});
