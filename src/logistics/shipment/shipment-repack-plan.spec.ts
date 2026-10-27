import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { RepackAllocation, RepackContent, planAllocationChanges } from './shipment-repack-plan';

const HU = 900n;
const OTHER_HU = 901n;
const ITEM = 11n;
const EA = 3n;
const d = (value: number) => new Prisma.Decimal(value);
const content = (lotId: bigint, qty: number, uomId = EA): RepackContent => ({ itemId: ITEM, lotId, uomId, qty: d(qty) });

function allocation(id: bigint, lotId: bigint, qty: number, extra: Partial<RepackAllocation> = {}): RepackAllocation {
  return {
    allocationId: id, shipmentLineId: 1n, lineNo: 1, itemId: ITEM, lotId, lotNo: `LOT-${lotId}`, uomId: EA, qty: d(qty),
    handlingUnitId: HU, deliveryLabelNo: null, ...extra,
  };
}

const plan = (before: RepackContent[], after: RepackContent[], allocations: RepackAllocation[]) =>
  planAllocationChanges(HU, before, after, allocations, (lotId) => `LOT-${lotId}`);

const messages = (run: () => unknown): string[] => {
  try {
    run();
  } catch (error) {
    return (error as ContractException).errors.map((item) => item.message);
  }
  throw new Error('던지지 않았다');
};

describe('planAllocationChanges — 상자 구성 증감을 배분에 옮긴다', () => {
  it('수량을 줄이거나 늘리면 그 LOT 의 배분 하나가 같은 만큼 바뀐다', () => {
    const changes = plan([content(1n, 10), content(2n, 5)], [content(1n, 8), content(2n, 6)],
      [allocation(101n, 1n, 10), allocation(102n, 2n, 5)]);

    expect(changes.map((change) => [change.allocation.allocationId, change.after.toNumber()])).toEqual([[101n, 8], [102n, 6]]);
  });

  it('LOT 을 빼면 그 배분이 0 이 된다 — 출하 줄에 다른 배분이 남아 있을 때', () => {
    const changes = plan([content(1n, 10), content(2n, 5)], [content(1n, 10)], [allocation(101n, 1n, 10), allocation(102n, 2n, 5)]);

    expect(changes.map((change) => [change.allocation.allocationId, change.after.toNumber()])).toEqual([[102n, 0]]);
  });

  it('바뀌지 않은 LOT 은 건드리지 않는다', () => {
    expect(plan([content(1n, 10)], [content(1n, 10)], [allocation(101n, 1n, 10)])).toEqual([]);
  });

  it('출하에 배분되지 않은 LOT 을 넣으면 400 — 다른 LOT 은 출하를 다시 등록하라고 안내한다', () => {
    expect(messages(() => plan([content(1n, 10)], [content(1n, 10), content(3n, 2)], [allocation(101n, 1n, 10)])))
      .toEqual(['LOT LOT-3: 이 상자에는 출하에 배분된 LOT 만 고칠 수 있습니다 — 다른 LOT 을 넣으려면 출하를 취소하고 다시 등록하세요.']);
  });

  it('단위만 바꾸는 것도 새 LOT 을 넣는 것과 같다 — 막는다', () => {
    expect(messages(() => plan([content(1n, 10)], [content(1n, 10, 4n)], [allocation(101n, 1n, 10), allocation(102n, 2n, 1)])))
      .toEqual([expect.stringContaining('LOT LOT-1: 이 상자에는 출하에 배분된 LOT 만')]);
  });

  it('같은 LOT 배분이 상자에 둘 이어졌거나, 상자에 배분되지 않은 수량이 섞였으면 400 — 고칠 배분을 정할 수 없다', () => {
    const two = [allocation(101n, 1n, 4), allocation(102n, 1n, 6, { shipmentLineId: 2n, lineNo: 2 })];
    expect(messages(() => plan([content(1n, 10)], [content(1n, 9)], two))[0]).toContain('고칠 배분을 정할 수 없습니다');
    expect(messages(() => plan([content(1n, 12)], [content(1n, 11)], [allocation(101n, 1n, 10)]))[0]).toContain('고칠 배분을 정할 수 없습니다');
  });

  it('다른 상자에 이어진 배분은 이 상자의 정정으로 바뀌지 않는다', () => {
    expect(messages(() => plan([content(1n, 10)], [content(1n, 9)], [allocation(101n, 1n, 10, { handlingUnitId: OTHER_HU })]))[0])
      .toContain('출하에 배분된 LOT 만');
  });

  it('출하 줄의 배분이 모두 0 이 되면 400 — 줄을 비우려면 출하를 다시 등록한다', () => {
    expect(messages(() => plan([content(1n, 10)], [], [allocation(101n, 1n, 10)])))
      .toEqual(['출하 1번 줄의 배분이 모두 0 이 됩니다 — 줄을 비우려면 출하를 취소하고 다시 등록하세요.']);
  });

  it('납품 라벨이 발행된 배분은 뺄 수 없다 — 수량만 고칠 수 있다', () => {
    const labeled = [allocation(101n, 1n, 10), allocation(102n, 2n, 5, { deliveryLabelNo: 'DL-1' })];
    expect(messages(() => plan([content(1n, 10), content(2n, 5)], [content(1n, 10)], labeled))[0]).toContain('납품 라벨(DL-1)');
    expect(plan([content(1n, 10), content(2n, 5)], [content(1n, 10), content(2n, 4)], labeled)).toHaveLength(1);
  });
});
