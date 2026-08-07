import { checkCodeLock, toEditability } from './editability';

describe('toEditability', () => {
  it('참조가 없으면 코드를 고칠 수 있다', () => {
    expect(toEditability(0)).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('한 건이라도 참조되면 잠근다 — 과거 전표가 무엇을 가리키는지 어긋난다', () => {
    expect(toEditability(1)).toEqual({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });
  });

  it('건수를 그대로 담는다 — 화면이 세지 않는다(공유계약 B-4)', () => {
    expect(toEditability(350)).toMatchObject({ referenceCount: 350 });
  });
});

describe('checkCodeLock', () => {
  const REFS = [{ schema: 'mdm', table: 'location', column: 'warehouse_id' }];

  function prismaWith(total: bigint) {
    return {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ total }]),
    } as unknown as Parameters<typeof checkCodeLock>[0];
  }

  it('코드가 그대로면 세지 않는다 — 이름만 고치는 것이 가장 흔한 수정이다', async () => {
    const prisma = prismaWith(500n);

    const errors = await checkCodeLock(prisma, REFS, 1n, 'warehouseCode', 'WH-01', 'WH-01');

    expect(errors).toEqual([]);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('코드를 바꾸는데 쓰이고 있으면 STATE_LOCKED 다', async () => {
    const errors = await checkCodeLock(
      prismaWith(500n),
      REFS,
      1n,
      'warehouseCode',
      'WH-01',
      'WH-99',
    );

    expect(errors).toEqual([
      { scope: 'field', field: 'warehouseCode', code: 'STATE_LOCKED', message: expect.any(String) },
    ]);
    expect(errors[0].message).toContain('500');
  });

  it('코드를 바꿔도 아무도 안 쓰면 통과한다', async () => {
    const errors = await checkCodeLock(prismaWith(0n), REFS, 1n, 'warehouseCode', 'WH-01', 'WH-99');

    expect(errors).toEqual([]);
  });
});
