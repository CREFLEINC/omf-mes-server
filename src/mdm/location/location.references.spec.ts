import { countReferences, referenceKey } from '../reference-count';
import { LOCATION_REFERENCES } from './location.references';
import { WAREHOUSE_REFERENCES } from '../warehouse/warehouse.references';

describe.each([
  ['WAREHOUSE_REFERENCES', WAREHOUSE_REFERENCES],
  ['LOCATION_REFERENCES', LOCATION_REFERENCES],
])('%s', (_name, references) => {
  it('같은 (스키마, 테이블, 컬럼)이 두 번 들어 있지 않다 — 중복은 건수를 부풀린다', () => {
    const keys = references.map(referenceKey);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('LOCATION_REFERENCES', () => {
  it('한 테이블이 로케이션을 두 방향으로 참조하는 경우를 빠뜨리지 않았다', () => {
    const keys = LOCATION_REFERENCES.map(referenceKey);

    expect(keys).toContain('inventory.inventory_transaction_line.from_location_id');
    expect(keys).toContain('inventory.inventory_transaction_line.to_location_id');
    expect(keys).toContain('logistics.stock_transfer_line.from_location_id');
    expect(keys).toContain('logistics.stock_transfer_line.to_location_id');
  });

  it('세 방향으로 참조하는 putaway_task·work_order 도 셋 다 들어 있다', () => {
    const keys = LOCATION_REFERENCES.map(referenceKey);

    expect(keys.filter((k) => k.startsWith('logistics.putaway_task.'))).toHaveLength(3);
    expect(keys.filter((k) => k.startsWith('production.work_order.'))).toHaveLength(3);
  });

  it('자기 자신을 가리키는 parent_location_id 가 들어 있다 — 하위 자리도 참조다', () => {
    expect(LOCATION_REFERENCES.map(referenceKey)).toContain('mdm.location.parent_location_id');
  });
});

describe('WAREHOUSE_REFERENCES', () => {
  it('한 테이블이 창고를 두 방향으로 참조하는 경우를 빠뜨리지 않았다', () => {
    const keys = WAREHOUSE_REFERENCES.map(referenceKey);

    expect(keys).toContain('inventory.inventory_transaction_line.from_warehouse_id');
    expect(keys).toContain('inventory.inventory_transaction_line.to_warehouse_id');
    expect(keys).toContain('logistics.stock_transfer.from_warehouse_id');
    expect(keys).toContain('logistics.stock_transfer.to_warehouse_id');
  });
});

describe('countReferences 식별자 검사', () => {
  it('식별자가 아닌 것이 섞이면 질의를 만들지 않고 던진다', async () => {
    const prisma = { $queryRawUnsafe: jest.fn() } as unknown as Parameters<typeof countReferences>[0];

    await expect(
      countReferences(prisma, [{ schema: 'mdm', table: 'location; DROP TABLE x', column: 'id' }], 1n),
    ).rejects.toThrow('쓸 수 없는 식별자');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([[WAREHOUSE_REFERENCES], [LOCATION_REFERENCES]])(
    '실제 목록은 전부 통과한다',
    async (references) => {
      const prisma = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ total: 0n }]),
      } as unknown as Parameters<typeof countReferences>[0];

      await expect(countReferences(prisma, references, 1n)).resolves.toBe(0);
    },
  );
});
