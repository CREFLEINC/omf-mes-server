import { ContractException } from '../../common/errors';
import { LotHoldCreate, LotHoldRelease, assertHoldCreateShape, assertHoldReleaseShape } from './lot-hold-rules';

/**
 * `lot-hold-rules.ts` 의 갈래 단위 시험(계획 §8-8). 등록(④)과 해제(⑤)를 **한 파일**에 둔다 —
 * 두 함수가 같은 표(`LOT_STATUS` 4값)를 «서로 다른 두 값»으로 좁히는 것이 이 파일의 핵심이고,
 * 갈라 두면 그 대조가 안 보인다.
 *
 * ⭐ **갈래 «순서»도 시험한다** — 한 요청이 두 규칙에 걸리면 «먼저» 적힌 것이 나야 e2e 의
 * 갈래와 어긋나지 않는다.
 */

/** 던진 것이 계약 봉투인지 + 첫 오류의 `field`·`code` 가 무엇인지 한 번에 본다. */
function errorsOf(run: () => unknown): { field?: string; code: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractException);
    const body = (error as ContractException).getResponse() as { errors: { field?: string; code: string }[] };
    return body.errors[0];
  }
  throw new Error('거절되지 않았다');
}

const SUSPECT: LotHoldCreate = {
  lots: [{ lotId: 1, versionNo: 1 }],
  reasonCode: 'FOREIGN_MATTER_SUSPECTED',
  targetLotStatusCode: 'INSPECTION_PENDING',
  releaseCondition: '재검사 후 판정 대기',
};
const CLAIM: LotHoldCreate = {
  lots: [{ lotId: 1, versionNo: 1 }],
  reasonCode: 'CLAIM_RECALL',
  targetLotStatusCode: 'DEFECTIVE',
};

describe('assertHoldCreateShape — 보류 등록 본문(계약 LotHoldCreate)', () => {
  it('의심자재(INSPECTION_PENDING)는 C10 액션이고 클레임·리콜(DEFECTIVE)은 C9 액션이다', () => {
    expect(assertHoldCreateShape(SUSPECT)).toBe('lot-hold-suspect');
    expect(assertHoldCreateShape(CLAIM)).toBe('lot-hold-claim');
  });

  it('⛔ 빈 lots 는 RANGE 다 — 「형식이 틀렸다」가 아니라 「개수가 모자라다」다(I-8 선례)', () => {
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, lots: [] }))).toEqual(
      expect.objectContaining({ field: 'lots', code: 'RANGE' }),
    );
    // `lots` 자체가 없어도 같은 갈래다(`body.lots ?? []`).
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, lots: undefined as unknown as [] }))).toEqual(
      expect.objectContaining({ field: 'lots', code: 'RANGE' }),
    );
  });

  it('⭐⭐ 같은 lotId 를 두 번 담으면 INVALID 다(RANGE 가 «아니다» · §12-1 ⓑ · 통보 081)', () => {
    const twice = { ...CLAIM, lots: [{ lotId: 7, versionNo: 1 }, { lotId: 7, versionNo: 2 }] };
    expect(errorsOf(() => assertHoldCreateShape(twice))).toEqual(
      expect.objectContaining({ field: 'lots', code: 'INVALID' }),
    );
  });

  it('⛔ holdQty·uomId 는 한 쌍이다 — 한쪽만 오면 PAIR(물리 CHECK 로 흘리면 500 이다)', () => {
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, holdQty: 10 }))).toEqual(
      expect.objectContaining({ field: 'uomId', code: 'PAIR' }),
    );
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, uomId: 3 }))).toEqual(
      expect.objectContaining({ field: 'holdQty', code: 'PAIR' }),
    );
  });

  it('⛔ holdQty 0 은 「전량 보류」가 아니다 — 전량은 NULL 이고 0 은 RANGE 다', () => {
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, holdQty: 0, uomId: 3 }))).toEqual(
      expect.objectContaining({ field: 'holdQty', code: 'RANGE' }),
    );
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, holdQty: -1, uomId: 3 }))).toEqual(
      expect.objectContaining({ field: 'holdQty', code: 'RANGE' }),
    );
  });

  it('⭐⭐ holdQty 도 소수 6자리까지다 — 7자리는 RANGE(`app.qty_t = numeric(20,6)` 이 조용히 반올림한다)', () => {
    expect(assertHoldCreateShape({ ...CLAIM, holdQty: 0.000001, uomId: 3 })).toBe('lot-hold-claim');
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, holdQty: 0.0000001, uomId: 3 }))).toEqual(
      expect.objectContaining({ field: 'holdQty', code: 'RANGE' }),
    );
    // ⛔ `> 0` 은 통과하는 값이다 — 0.0000001 이 그대로 저장되면 컬럼이 **0 으로 접어** 「수량 0 짜리 열린 보류」가 선다.
    expect(0.0000001 > 0).toBe(true);
  });

  it('⭐ LOT 2건 이상이면 holdQty 를 못 준다 — 수량은 LOT 마다 달라 뜻을 잃는다(`W-03-03` §5-3)', () => {
    const two = { ...CLAIM, lots: [{ lotId: 1, versionNo: 1 }, { lotId: 2, versionNo: 1 }], holdQty: 10, uomId: 3 };
    expect(errorsOf(() => assertHoldCreateShape(two))).toEqual(
      expect.objectContaining({ field: 'holdQty', code: 'INVALID' }),
    );
  });

  it('⭐ 등록의 도착 상태는 두 값뿐이다 — LOT_STATUS 4값 중 NORMAL·SCRAPPED 는 INVALID', () => {
    for (const target of ['NORMAL', 'SCRAPPED']) {
      expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, targetLotStatusCode: target }))).toEqual(
        expect.objectContaining({ field: 'targetLotStatusCode', code: 'INVALID' }),
      );
    }
  });

  it('⛔ 프로토타입 이름이 값 목록을 통과하지 않는다 — 평범한 객체가 아니라 Map 이라서다', () => {
    for (const target of ['constructor', 'toString', '__proto__']) {
      expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, targetLotStatusCode: target }))).toEqual(
        expect.objectContaining({ field: 'targetLotStatusCode', code: 'INVALID' }),
      );
    }
  });

  it('⭐ releaseCondition 은 조건부다 — 검사 대기면 REQUIRED, 불량이면 INVALID(두 갈래의 코드가 다르다)', () => {
    const { releaseCondition, ...withoutCondition } = SUSPECT;
    expect(releaseCondition).toBeDefined();
    expect(errorsOf(() => assertHoldCreateShape(withoutCondition as LotHoldCreate))).toEqual(
      expect.objectContaining({ field: 'releaseCondition', code: 'REQUIRED' }),
    );
    expect(errorsOf(() => assertHoldCreateShape({ ...CLAIM, releaseCondition: '있으면 안 된다' }))).toEqual(
      expect.objectContaining({ field: 'releaseCondition', code: 'INVALID' }),
    );
  });

  it('⭐ 갈래 «순서» — 한 본문이 여럿에 걸리면 위에 적힌 것이 난다(중복 → 짝 → 2LOT → 도착 → 조건)', () => {
    // 중복 lotId «그리고» holdQty 짝 결손 — 중복이 먼저다.
    const both = { ...CLAIM, lots: [{ lotId: 7, versionNo: 1 }, { lotId: 7, versionNo: 1 }], holdQty: 10 };
    expect(errorsOf(() => assertHoldCreateShape(both))).toEqual(
      expect.objectContaining({ field: 'lots', code: 'INVALID' }),
    );
    // 도착 상태가 틀렸고 releaseCondition 도 어긋난다 — 도착이 먼저다(액션을 못 고르면 뒤가 뜻이 없다).
    const target = { ...CLAIM, targetLotStatusCode: 'NORMAL', releaseCondition: '있으면 안 된다' };
    expect(errorsOf(() => assertHoldCreateShape(target))).toEqual(
      expect.objectContaining({ field: 'targetLotStatusCode', code: 'INVALID' }),
    );
  });
});

const ACCEPT: LotHoldRelease = { targetLotStatusCode: 'NORMAL', releaseReasonCode: 'RETEST_PASS' };

describe('assertHoldReleaseShape — 보류 해제 본문(계약 LotHoldRelease)', () => {
  it('⭐ 재판정 합격(NORMAL)은 C7, 재판정 불합격(DEFECTIVE)은 C8 이다', () => {
    expect(assertHoldReleaseShape(ACCEPT)).toBe('lot-hold-release-accepted');
    expect(assertHoldReleaseShape({ ...ACCEPT, targetLotStatusCode: 'DEFECTIVE' })).toBe('lot-hold-release-rejected');
  });

  it('⭐⭐ 해제의 도착 두 값은 «등록의 두 값과 다르다» — INSPECTION_PENDING 은 INVALID 다', () => {
    // 등록(C10)의 도착이지 해제(C7·C8)의 도착이 아니다. 두 표를 합치면 이 요청이 샌다.
    expect(errorsOf(() => assertHoldReleaseShape({ ...ACCEPT, targetLotStatusCode: 'INSPECTION_PENDING' }))).toEqual(
      expect.objectContaining({ field: 'targetLotStatusCode', code: 'INVALID' }),
    );
    expect(errorsOf(() => assertHoldReleaseShape({ ...ACCEPT, targetLotStatusCode: 'SCRAPPED' }))).toEqual(
      expect.objectContaining({ field: 'targetLotStatusCode', code: 'INVALID' }),
    );
  });

  it('⛔ 프로토타입 이름이 통과하지 않는다 — 이쪽도 Map 이다', () => {
    for (const target of ['constructor', 'toString', '__proto__']) {
      expect(errorsOf(() => assertHoldReleaseShape({ ...ACCEPT, targetLotStatusCode: target }))).toEqual(
        expect.objectContaining({ field: 'targetLotStatusCode', code: 'INVALID' }),
      );
    }
  });

  it('releaseQty 는 생략할 수 있고(전량 해제), 있으면 0 보다 커야 한다(RANGE)', () => {
    expect(assertHoldReleaseShape(ACCEPT)).toBe('lot-hold-release-accepted');
    expect(assertHoldReleaseShape({ ...ACCEPT, releaseQty: 0.000001 })).toBe('lot-hold-release-accepted');
    for (const qty of [0, -1]) {
      expect(errorsOf(() => assertHoldReleaseShape({ ...ACCEPT, releaseQty: qty }))).toEqual(
        expect.objectContaining({ field: 'releaseQty', code: 'RANGE' }),
      );
    }
  });

  it(
    '⭐⭐ releaseQty 는 소수 **6자리까지**다 — 7자리는 RANGE (↩ 절을 지우거나 `> 6` 을 `> 7` 로 넓히면, ' +
      '잔량 `1e-7` 이 `numeric(20,6)` 에 0 으로 접혀 「보류 수량 0 짜리 열린 보류」가 서고 LOT 이 영영 안 움직인다)',
    () => {
      // 위 시험이 축복한 6자리(`0.000001`)가 «경계»다 — 한 자리만 더 가면 거절이다.
      expect(assertHoldReleaseShape({ ...ACCEPT, releaseQty: 0.000001 })).toBe('lot-hold-release-accepted');
      for (const qty of [0.0000001, 99.9999999]) {
        expect(errorsOf(() => assertHoldReleaseShape({ ...ACCEPT, releaseQty: qty }))).toEqual(
          expect.objectContaining({ field: 'releaseQty', code: 'RANGE' }),
        );
      }
      // 정수부는 안 센다 — 6자리이기만 하면 자리수가 커도 통과다(`numeric(20,6)` 의 정수 14자리 안이다).
      expect(assertHoldReleaseShape({ ...ACCEPT, releaseQty: 99999999.123456 })).toBe('lot-hold-release-accepted');
    },
  );

  it('⭐ 갈래 순서 — 도착 상태가 releaseQty 보다 먼저다(액션을 못 고르면 수량은 뜻이 없다)', () => {
    const both = { ...ACCEPT, targetLotStatusCode: 'INSPECTION_PENDING', releaseQty: 0 };
    expect(errorsOf(() => assertHoldReleaseShape(both))).toEqual(
      expect.objectContaining({ field: 'targetLotStatusCode', code: 'INVALID' }),
    );
  });

  it('⛔ `releaseQty` 와 `hold_qty` 의 관계는 여기서 «안» 본다 — 저장된 행을 읽어야 알 수 있다(트랜잭션 안)', () => {
    // 전량 보류에 부분 해제(400 INVALID)·초과(400 RANGE)는 서비스가 낸다 — 여기서는 통과한다.
    expect(assertHoldReleaseShape({ ...ACCEPT, releaseQty: 999999 })).toBe('lot-hold-release-accepted');
  });
});
