import { Prisma } from '@prisma/client';

import { ConflictException, ContractException } from '../../common/errors';
import { assertWithinDecision, planHoldRelease } from './stock-reinstatement-rules';

const dec = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

const caught = <T>(run: () => void): T => {
  try {
    run();
  } catch (error) {
    return error as T;
  }
  throw new Error('던지지 않았다');
};

describe('재등록 — 보류 해제 계획', () => {
  it('보류 수량보다 적으면 «부분» — 그 수량만 푼다', () => {
    expect(planHoldRelease(dec(10), dec(4), dec(10))).toEqual({ kind: 'partial', releaseQty: dec(4) });
  });

  it('보류 수량과 같으면 전량이다', () => {
    expect(planHoldRelease(dec(10), dec(10), dec(10))).toEqual({ kind: 'full' });
  });

  it('⛔ 보류 수량보다 많으면 400 RANGE 다', () => {
    const failure = caught<ContractException>(() => planHoldRelease(dec(10), dec(11), dec(99)));
    expect(failure.errors[0]).toMatchObject({ field: 'qty', code: 'RANGE' });
  });

  it('⛔⛔ 전량 보류(NULL)를 불량 잔액보다 적게 재등록하면 400 — 남은 불량이 보류 없이 풀린다', () => {
    // 코어가 NULL 보류에는 잔량 행을 안 세운다 — 그대로 닫으면 openAfter 0 → LOT 이 NORMAL 로 간다.
    const failure = caught<ContractException>(() => planHoldRelease(null, dec(4), dec(10)));
    expect(failure.errors[0]).toMatchObject({ field: 'qty', code: 'RANGE' });
    expect(failure.errors[0].message).toContain('전량 보류');
  });

  it('전량 보류를 불량 잔액만큼 재등록하면 전량이다', () => {
    expect(planHoldRelease(null, dec(10), dec(10))).toEqual({ kind: 'full' });
  });
});

describe('재등록 — 처분 수량 한도', () => {
  it('합이 처분 수량 안이면 통과한다 — 부분 재등록이 본길이다', () => {
    expect(() => assertWithinDecision(dec(4), dec(10), dec(6))).not.toThrow();
  });

  it('⭐ 이미 전량 재등록됐으면 409 ALREADY_REINSTATED — 「한 번 했다」가 아니라 «합»이 닿았을 때다', () => {
    const failure = caught<ConflictException>(() => assertWithinDecision(dec(10), dec(10), dec(1)));
    expect(failure.getStatus()).toBe(409);
    expect(failure.conflict.code).toBe('ALREADY_REINSTATED');
  });

  it('⛔ 남은 한도를 넘기면 400 RANGE 다(409 가 아니다 — 아직 전량이 아니다)', () => {
    const failure = caught<ContractException>(() => assertWithinDecision(dec(4), dec(10), dec(7)));
    expect(failure.errors[0]).toMatchObject({ field: 'qty', code: 'RANGE' });
  });
});
