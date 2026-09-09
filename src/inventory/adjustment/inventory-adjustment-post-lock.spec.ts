import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

/**
 * ⭐ e2e 가 도달하지 못하는 것 하나만 확정한다 — **헤더 자물쇠**.
 *
 * `FOR UPDATE` 를 빼거나 `FOR SHARE` 로 낮춰도 e2e 는 전부 초록이다(경쟁을 재는 시험이 이
 * 저장소에 0건이다). 그러면 같은 순간의 두 `:post` 가 둘 다 `REGISTERED` 를 보고 **잔액을 두
 * 번 움직인다** — 원장 멱등키가 흡수해도 `alreadyPosted` 가 500 으로 파열한다.
 * 원시 SQL 을 단위 스펙이 지켜보는 것은 `stock-transfer-lock.spec.ts` 가 깐 선례다.
 */

interface Recorded {
  calls: string[];
  lockSql: string;
  lockValues: unknown[];
}

function fake(row: { status_code: string; version_no: number } | undefined) {
  const recorded: Recorded = { calls: [], lockSql: '', lockValues: [] };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.calls.push('lock');
      recorded.lockSql = strings.join('?');
      recorded.lockValues = values;
      return row === undefined
        ? []
        : [{ inventory_adjustment_id: 500n, inventory_adjustment_no: 'IA-20260601-0001', ...row }];
    },
  };
  const prisma = {
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      recorded.calls.push('transaction');
      return work(tx);
    },
  };
  const service = new InventoryAdjustmentService(
    prisma as unknown as PrismaService,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    new DocumentStateService(),
  );
  return { service, recorded };
}

const body = { businessDate: '2026-06-01', occurredAt: '2026-06-01T01:00:00.000Z' };

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('던지지 않았다');
};

describe('InventoryAdjustmentService.post — 헤더 자물쇠', () => {
  it('⭐ 헤더를 `$transaction` «안»에서 `FOR UPDATE` 로 잠근다 — 그 행 하나만', async () => {
    const { service, recorded } = fake({ status_code: 'POSTED', version_no: 3 });

    await thrown(() => service.post(500, 3, body, 1));

    expect(recorded.calls).toEqual(['transaction', 'lock']);
    expect(recorded.lockSql).toContain('FOR UPDATE');
    expect(recorded.lockSql).toContain('inventory.inventory_adjustment');
    expect(recorded.lockSql).toContain('WHERE inventory_adjustment_id =');
    expect(recorded.lockValues).toEqual([500]);
  });

  it('잠근 행이 없으면 404 다 — 400 을 먼저 내지 않는다', async () => {
    const { service } = fake(undefined);

    const error = await thrown(() => service.post(500, 3, body, 1));

    expect(error).not.toBeInstanceOf(ContractException);
    expect((error as { status?: number }).status).toBe(404);
  });

  it('잠근 값으로 판정한다 — 버전이 어긋나면 409 이고 상태를 안 본다', async () => {
    // 상태가 `REGISTERED` 라 버전만 통과하면 그대로 전기로 나아간다 — 409 가 «먼저»다.
    const { service } = fake({ status_code: 'REGISTERED', version_no: 4 });

    expect(await thrown(() => service.post(500, 3, body, 1))).toBeInstanceOf(ConflictException);
  });

  it('전기된 조정의 재전기는 400 STATE_LOCKED — 잠근 `status_code` 를 실제로 읽는다', async () => {
    const { service } = fake({ status_code: 'POSTED', version_no: 3 });

    const error = await thrown(() => service.post(500, 3, body, 1));

    expect((error as ContractException).errors[0]).toMatchObject({ code: ERROR_CODE.STATE_LOCKED });
  });

  it('본문 형식은 트랜잭션 «밖»에서 본다 — 없는 전표 + 잘못된 businessDate 는 400 이다', async () => {
    const { service, recorded } = fake(undefined);

    const error = await thrown(() => service.post(500, 3, { ...body, businessDate: '2026-6-1' }, 1));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'businessDate',
      code: ERROR_CODE.INVALID,
    });
    expect(recorded.calls).toEqual([]);
  });
});
