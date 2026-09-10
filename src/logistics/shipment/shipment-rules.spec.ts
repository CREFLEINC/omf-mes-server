import { ContractException } from '../../common/errors';
import {
  assertAllocationSum,
  assertLotsReleased,
  assertQty,
  assertShipmentQty,
} from './shipment-rules';

const caught = (run: () => void): ContractException => {
  try {
    run();
  } catch (error) {
    return error as ContractException;
  }
  throw new Error('던지지 않았다');
};

const line = (shippedQty: number, ...allocated: number[]) => ({
  shippedQty,
  allocations: allocated.map((allocatedQty) => ({ allocatedQty })),
});

describe('출하 수량 가드', () => {
  it('소수 여섯째 자리까지는 통과한다', () => {
    expect(() => assertQty('q', 10.123456)).not.toThrow();
    expect(() => assertQty('q', 0.000001)).not.toThrow();
  });

  it('⛔ 소수 «일곱째» 자리는 400 RANGE 다 — 그대로 두면 DB 가 조용히 반올림한다', () => {
    // `10.0000005` 는 numeric(20,6) 에서 `10.000001` 이 된다. 원장은 소급 정정이 안 되므로
    // 그 반올림이 영구다.
    const failure = caught(() => assertQty('lines[0].shippedQty', 10.0000005));

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({
      field: 'lines[0].shippedQty',
      code: 'RANGE',
    });
  });

  it('⛔ 정수부 15자리는 400 RANGE 다 — 계약 미선언 500 을 앞당긴다', () => {
    expect(() => assertQty('q', 99999999999999)).not.toThrow();
    expect(caught(() => assertQty('q', 1e15)).getStatus()).toBe(400);
    // 음수는 계약이 exclusiveMinimum 0 으로 막지만, 절댓값으로 재야 −1e15 가 새지 않는다.
    expect(caught(() => assertQty('q', -1e15)).getStatus()).toBe(400);
  });

  it('⭐ 라인과 «배분»을 둘 다 본다 — 라인만 보면 배분의 1e15 가 그대로 들어간다', () => {
    const failure = caught(() => assertShipmentQty([line(10, 10.0000005)]));

    expect(failure.errors[0].field).toBe('lines[0].allocations[0].allocatedQty');
  });

  it('경로가 라인·배분 «번호»를 짚는다 — 화면이 어느 칸인지 안다', () => {
    const failure = caught(() => assertShipmentQty([line(5, 5), line(3, 1, 1e15)]));

    expect(failure.errors[0].field).toBe('lines[1].allocations[1].allocatedQty');
  });
});

describe('배분 합 불변식', () => {
  it('합이 라인 수량과 같으면 통과한다', () => {
    expect(() => assertAllocationSum([line(10, 6, 4)])).not.toThrow();
  });

  it('⭐ Decimal 로 센다 — 0.1 + 0.2 를 number 로 더하면 정상 요청이 400 이 된다', () => {
    // ⛔ `0.1 + 0.2 === 0.30000000000000004` 다. `0.15 + 0.15` 는 JS 에서 정확히 0.3 이라
    //    함정을 안 건드린다(README §6-3 ⑸).
    expect(() => assertAllocationSum([line(0.3, 0.1, 0.2)])).not.toThrow();
  });

  it('⛔ 어긋나면 400 RANGE — DB 에 이 불변식을 보는 제약이 «없다»', () => {
    const failure = caught(() => assertAllocationSum([line(10, 6, 3)]));

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({ field: 'lines[0].allocations', code: 'RANGE' });
    expect(failure.errors[0].message).toContain('9');
  });

  it('⭐ 라인 전건을 «한 봉투»로 던진다 — 화면이 라인마다 왕복하지 않는다', () => {
    const failure = caught(() => assertAllocationSum([line(10, 6, 3), line(5, 5), line(7, 1)]));

    expect(failure.errors.map((item) => item.field)).toEqual([
      'lines[0].allocations',
      'lines[2].allocations',
    ]);
  });
});

describe('출하 품질 게이트', () => {
  const path = (lotId: bigint | number): string => `lot:${lotId}`;

  it('Release(NORMAL) 만 통과한다', () => {
    expect(() =>
      assertLotsReleased([{ lotId: 1n, statusCode: 'NORMAL' }], path),
    ).not.toThrow();
  });

  it('⛔ 그 밖은 전부 400 STATE_LOCKED — «양성» 판정이다', () => {
    // ⛔ 출고 코어의 assertLotNotBlocked 는 judgment_type_control 을 보는 «음성» 판정이고
    //    그 표가 비어 오늘 아무것도 막지 않는다. 출하 계약은 「Release 만」을 요구한다.
    for (const status of ['DEFECTIVE', 'INSPECTION_PENDING', 'SCRAPPED', 'HOLD']) {
      const failure = caught(() => assertLotsReleased([{ lotId: 9n, statusCode: status }], path));
      expect(failure.getStatus()).toBe(400);
      expect(failure.errors[0]).toMatchObject({ field: 'lot:9', code: 'STATE_LOCKED' });
      expect(failure.errors[0].message).toContain(status);
    }
  });

  it('⭐ 여러 LOT 이 걸리면 «전건»을 한 봉투로 짚는다 — 첫 건만 고치고 다시 오지 않게', () => {
    const failure = caught(() =>
      assertLotsReleased(
        [
          { lotId: 1n, statusCode: 'NORMAL' },
          { lotId: 2n, statusCode: 'DEFECTIVE' },
          { lotId: 3n, statusCode: 'SCRAPPED' },
        ],
        path,
      ),
    );

    expect(failure.errors.map((item) => item.field)).toEqual(['lot:2', 'lot:3']);
  });
});
