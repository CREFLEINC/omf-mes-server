import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { assertReturnable } from './shipment-pick-return.service';

const d = (value: number) => new Prisma.Decimal(value);
const message = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return (error as ContractException).errors[0].message;
  }
  throw new Error('던지지 않았다');
};

describe('assertReturnable — 반납 한도는 라인·LOT 의 피킹 − 출하', () => {
  it('피킹 − 출하까지는 통과한다 — 경계값 포함', () => {
    expect(() => assertReturnable('L1', d(5), d(30), d(25))).not.toThrow();
  });

  it('출하에 쓴 몫을 넘으면 피킹·출하 수와 조치를 알린다', () => {
    expect(message(() => assertReturnable('L1', d(6), d(30), d(25))))
      .toBe('LOT L1: 출하하지 않은 피킹분은 5 입니다(피킹 30 · 출하 25) — 출하에 쓴 몫은 출하 취소나 상자 정정으로 먼저 줄이세요.');
  });

  it('출하가 피킹보다 많아도(상자 정정으로 늘린 경우) 반납 가능은 0 이다', () => {
    expect(message(() => assertReturnable('L1', d(1), d(10), d(12)))).toContain('출하하지 않은 피킹분은 0 입니다');
  });
});
