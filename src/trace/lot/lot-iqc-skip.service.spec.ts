import { ContractException, ErrorItem } from '../../common/errors';
import { LotQualification, assertSkippable } from './lot-iqc-skip.service';

const SKIPPABLE: LotQualification = {
  source_type_code: 'INBOUND_RECEIPT_LINE',
  status_code: 'INSPECTION_PENDING',
};

function rejected(lot: LotQualification): ErrorItem {
  try {
    assertSkippable(lot);
  } catch (error) {
    return (error as ContractException).errors[0];
  }
  throw new Error('자격 없는 LOT 을 통과시켰다');
}

describe('IQC 생략 요청 — 자격 두 축 (I-18 PR ②)', () => {
  it('⭐ 원천이 입하가 아니면 INVALID 다 — 상태 위반과 «다른» 코드다', () => {
    // 형제 `:complete` 가 원천 유형 위반에 쓰는 코드와 같다(`lot-complete.service.ts:67-69`).
    expect(rejected({ ...SKIPPABLE, source_type_code: 'WORK_ORDER' })).toMatchObject({
      field: 'lotId',
      code: 'INVALID',
    });
  });

  it('⭐ 검사 대기가 아니면 STATE_LOCKED 다 — 대상이지만 지금은 그 상태가 아니다', () => {
    expect(rejected({ ...SKIPPABLE, status_code: 'NORMAL' })).toMatchObject({
      field: 'lotId',
      code: 'STATE_LOCKED',
    });
    // 순서 — 두 축이 함께 어긋나면 원천 쪽이 먼저다.
    expect(rejected({ source_type_code: 'WORK_ORDER', status_code: 'NORMAL' }).code).toBe('INVALID');
  });

  it('입하돼 수입검사 대기인 LOT 은 통과한다 — 보류 유무는 보지 않는다', () => {
    expect(() => assertSkippable(SKIPPABLE)).not.toThrow();
  });
});
