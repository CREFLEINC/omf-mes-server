import { PrismaService } from '../../prisma/prisma.service';
import { ItemService, ItemUpdate } from './item.service';

/** omf-all-around#215 — 품목 「수입검사 대상」을 저장하면 그 품목 전용 IQC 기준의 「기본 생략」이 반대로 맞춰진다. */
function harness() {
  const planUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    item: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    inspection_plan: { updateMany: planUpdateMany },
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const service = new ItemService(prisma);
  // 검증·조회는 이 스위트가 보지 않는다 — 저장 트랜잭션 안의 연동만 본다.
  const internals = service as unknown as Record<string, unknown>;
  internals.assertWritable = jest.fn().mockResolvedValue(undefined);
  internals.assertExists = jest.fn().mockResolvedValue(undefined);
  internals.get = jest.fn().mockResolvedValue({});
  return { service, tx, planUpdateMany };
}

const body = (inspectionRequired: boolean): ItemUpdate => ({
  lotControlled: true,
  serialControlTypeCode: 'NONE',
  inspectionRequired,
  fifoPolicyCode: 'FIFO',
  negativeStockAllowed: false,
  isActive: true,
});

describe('품목 저장 — IQC 검사 기준 「기본 생략」 연동 (omf-all-around#215)', () => {
  it('수입검사 대상을 끄면 그 품목의 사용 중인 IQC 기준을 기본 생략으로 맞춘다(어긋난 기준만)', async () => {
    const { service, planUpdateMany } = harness();
    await service.update(40, 1, body(false));

    expect(planUpdateMany).toHaveBeenCalledWith({
      where: { item_id: 40, inspection_type_code: 'IQC', is_active: true, default_skip: false },
      data: { default_skip: true, pqc_skip_allowed: true, version_no: { increment: 1 } },
    });
  });

  it('수입검사 대상을 켜면 기본 생략을 끈다', async () => {
    const { service, planUpdateMany } = harness();
    await service.update(40, 1, body(true));

    expect(planUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { default_skip: false, pqc_skip_allowed: false, version_no: { increment: 1 } } }),
    );
  });

  it('저장이 0행(낙관적 잠금 충돌)이면 기준을 건드리지 않는다', async () => {
    const { service, tx, planUpdateMany } = harness();
    tx.item.updateMany.mockResolvedValueOnce({ count: 0 });
    await service.update(40, 1, body(false));

    expect(planUpdateMany).not.toHaveBeenCalled();
  });
});
