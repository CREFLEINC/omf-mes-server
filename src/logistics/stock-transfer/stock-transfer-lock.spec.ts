import { ConflictException, ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { StockTransferService } from './stock-transfer.service';

/**
 * ⭐ e2e 가 도달하지 못하는 것 하나만 확정한다 — **자물쇠**.
 *
 * 라인 치환은 오늘 언제나 400/409/404 로 닫히므로 `FOR UPDATE` 를 통째로 빼도 e2e 48건이
 * 전부 초록이다(계획 §12-0 변이 ⑩). 경쟁을 실제로 재는 테스트는 이 저장소에 선례가 0이지만,
 * **원시 SQL 을 단위 스펙이 지켜보는** 선례는 12파일 23단언으로 많다
 * (같은 도메인: `inbound-receipt-update.service.spec.ts` 의 `replaceLines` 잠금).
 *
 * ⛔ 잠금이 사라지면 도착이 그 사이 `version_no` 를 올려도 stale 값으로 대조를 통과해
 *    **경쟁 시 409 대신 400** 이 나간다.
 */

interface Recorded {
  calls: string[];
  lockSql: string;
  lockValues: unknown[];
}

function fake(row: { shipped_at: Date | null; version_no: number } | undefined) {
  const recorded: Recorded = { calls: [], lockSql: '', lockValues: [] };

  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.calls.push('lock');
      recorded.lockSql = strings.join('?');
      recorded.lockValues = values;
      return row === undefined ? [] : [row];
    },
  };

  const prisma = {
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      recorded.calls.push('transaction');
      return work(tx);
    },
  };

  const service = new StockTransferService(
    prisma as unknown as PrismaService,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { service, recorded };
}

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('던지지 않았다');
};

describe('StockTransferService.replaceLines — 자물쇠', () => {
  it('⭐ 헤더를 `$transaction` «안»에서 `FOR UPDATE` 로 잠근다 — 그 행 하나만', async () => {
    const { service, recorded } = fake({ shipped_at: new Date('2026-09-09T02:00:00.000Z'), version_no: 3 });

    await thrown(() => service.replaceLines(500, 3));

    expect(recorded.calls).toEqual(['transaction', 'lock']);
    expect(recorded.lockSql).toContain('FOR UPDATE');
    expect(recorded.lockSql).toContain('logistics.stock_transfer');
    expect(recorded.lockSql).toContain('WHERE stock_transfer_id =');
    expect(recorded.lockValues).toEqual([500n]);
  });

  it('잠근 값으로 판정한다 — 버전이 어긋나면 409 이고 `shipped_at` 을 안 본다', async () => {
    const { service } = fake({ shipped_at: null, version_no: 4 });

    // `shipped_at` 이 널이라 버전만 통과하면 500 으로 파열한다 — 409 가 «먼저»다.
    expect(await thrown(() => service.replaceLines(500, 3))).toBeInstanceOf(ConflictException);
  });

  it('잠근 행이 없으면 404 다 — 400 을 먼저 내지 않는다', async () => {
    const { service } = fake(undefined);

    const error = await thrown(() => service.replaceLines(500, 3));

    expect(error).not.toBeInstanceOf(ContractException);
    expect((error as { status?: number }).status).toBe(404);
  });

  it('반출이 끝난 전표는 400 STATE_LOCKED — 잠근 `shipped_at` 을 실제로 읽는다', async () => {
    const { service } = fake({ shipped_at: new Date('2026-09-09T02:00:00.000Z'), version_no: 3 });

    const error = await thrown(() => service.replaceLines(500, 3));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'items',
      code: ERROR_CODE.STATE_LOCKED,
    });
  });
});
