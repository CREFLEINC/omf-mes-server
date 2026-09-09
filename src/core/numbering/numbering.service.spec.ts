import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from './numbering.service';

const PLANT = 7n;
const OTHER_PLANT = 9n;
const DAY = '2026-09-06';

interface RuleSeed {
  numbering_rule_id: bigint;
  document_type_code: string;
  plant_id: bigint | null;
  pattern: string;
  reset_cycle_code: string;
  is_active: boolean;
}

const rule = (seed: Partial<RuleSeed> & { pattern: string }): RuleSeed => ({
  numbering_rule_id: 1n,
  document_type_code: 'GOODS_RECEIPT',
  plant_id: null,
  reset_cycle_code: 'DAILY',
  is_active: true,
  ...seed,
});

/**
 * 카운터를 «상태로» 흉내 낸다 — 「두 번째 호출은 1 오른다」·「기간이 바뀌면 다시 센다」가
 * 값의 변화를 보는 시험이라 한 번 답하고 마는 목으로는 못 잡는다.
 */
function fake(seeded: RuleSeed[] = []) {
  const rules = [...seeded];
  const counters = new Map<string, bigint>();
  const inserted: { documentTypeCode: string; pattern: string }[] = [];
  let ruleId = 900n;

  const prisma = {
    numbering_rule: {
      findMany: async ({ where }: { where: { document_type_code: string; OR: { plant_id: bigint | null }[] } }) => {
        const plantId = where.OR[0].plant_id;
        return rules.filter(
          (row) =>
            row.document_type_code === where.document_type_code &&
            (row.plant_id === null || row.plant_id === plantId),
        );
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('app.numbering_rule')) {
        const [documentTypeCode, pattern, resetCycleCode] = values as [string, string, string];
        inserted.push({ documentTypeCode, pattern });
        ruleId += 1n;
        // 만든 행은 «남는다» — 다음 호출이 자동 생성이 아니라 조회로 찾아야 카운터가 이어진다.
        const created = rule({
          numbering_rule_id: ruleId,
          document_type_code: documentTypeCode,
          pattern,
          reset_cycle_code: resetCycleCode,
        });
        rules.push(created);
        return [created];
      }
      const [numberingRuleId, periodKey] = values as [bigint, string];
      const key = `${numberingRuleId}:${periodKey}`;
      const last = (counters.get(key) ?? 0n) + 1n;
      counters.set(key, last);
      return [{ last_value: last }];
    },
  };
  return { service: new NumberingService(prisma as unknown as PrismaService), inserted };
}

describe('채번 코어', () => {
  it('채번 — 규칙이 있으면 그 패턴을 쓴다(PR-{YYMMDD}-{SEQ4})', async () => {
    const { service } = fake([
      rule({ document_type_code: 'PRODUCTION_RESULT', pattern: 'PR-{YYMMDD}-{SEQ4}' }),
    ]);

    expect(await service.next('PRODUCTION_RESULT', null, DAY)).toBe('PR-260906-0001');
  });

  it('채번 — 규칙이 없으면 {PREFIX}-{YYYYMMDD}-{SEQ4} 로 떨어진다', async () => {
    const { service } = fake();

    expect(await service.next('GOODS_RECEIPT', PLANT, DAY)).toBe('GR-20260906-0001');
  });

  it('채번 — 규칙이 없으면 그 문서 유형의 규칙 행을 만들어 둔다(회신이 오면 seed 가 패턴만 덮는다)', async () => {
    const { service, inserted } = fake();

    await service.next('NOTICE', null, DAY);

    expect(inserted).toEqual([
      { documentTypeCode: 'NOTICE', pattern: 'NTC-{YYYYMMDD}-{SEQ4}' },
    ]);
  });

  it('채번 — INBOUND_RECEIPT 의 기본 접두어는 IR 이다', async () => {
    const { service } = fake();

    expect(await service.next('INBOUND_RECEIPT', PLANT, DAY)).toBe('IR-20260906-0001');
  });

  it('채번 — GOODS_ISSUE 의 기본 접두어는 GI 다(규칙 미등재)', async () => {
    const { service } = fake();

    expect(await service.next('GOODS_ISSUE', PLANT, DAY)).toBe('GI-20260906-0001');
  });

  it('채번 — 설비 점검·고장은 EQI·MLF 기본 접두어를 쓴다', async () => {
    const { service } = fake();

    expect(await service.next('EQUIPMENT_INSPECTION', PLANT, DAY)).toBe('EQI-20260906-0001');
    expect(await service.next('BREAKDOWN', PLANT, DAY)).toBe('MLF-20260906-0001');
  });

  it('채번 — 보전 지시는 MO 기본 접두어를 쓴다', async () => {
    const { service } = fake();

    expect(await service.next('MAINTENANCE_ORDER', PLANT, DAY)).toBe('MO-20260906-0001');
  });

  it('채번 — 부적합은 NC 기본 접두어를 쓰고 공장 축이 없다(plantId=null)', async () => {
    const { service } = fake();

    expect(await service.next('NONCONFORMANCE', null, DAY)).toBe('NC-20260906-0001');
  });

  it('채번 — 출하지시서·재고예약은 SR·RS 기본 접두어를 쓴다 // 결정 — 통보 191', async () => {
    const { service } = fake();

    // ⚠ `SR` 는 이미 있는 `SHOPFLOOR_RECEIPT` 와 겹친다 — 두 계약 example 이 둘 다 `SR-` 라
    //   계약 문자를 따랐다. 카운터가 문서 유형별이라 같은 날 첫 건이면 두 표에 하나씩 선다.
    expect(await service.next('SHIPMENT_REQUEST', PLANT, DAY)).toBe('SR-20260906-0001');
    expect(await service.next('SHOPFLOOR_RECEIPT', PLANT, DAY)).toBe('SR-20260906-0001');
    expect(await service.next('INVENTORY_RESERVATION', null, DAY)).toBe('RS-20260906-0001');
  });

  it('채번 — 공장 지정 규칙이 전역 규칙을 이긴다', async () => {
    const { service } = fake([
      rule({ numbering_rule_id: 1n, pattern: 'GR-{YYYYMMDD}-{SEQ4}' }),
      rule({ numbering_rule_id: 2n, plant_id: PLANT, pattern: 'GRP-{YYYYMMDD}-{SEQ4}' }),
      rule({ numbering_rule_id: 3n, plant_id: OTHER_PLANT, pattern: 'GRX-{YYYYMMDD}-{SEQ4}' }),
    ]);

    expect(await service.next('GOODS_RECEIPT', PLANT, DAY)).toBe('GRP-20260906-0001');
  });

  it('채번 — 같은 기간의 두 번째 호출은 SEQ 가 1 오른다', async () => {
    const { service } = fake();

    await service.next('GOODS_RECEIPT', null, DAY);

    expect(await service.next('GOODS_RECEIPT', null, DAY)).toBe('GR-20260906-0002');
  });

  it('채번 — 기간이 바뀌면 SEQ 가 1 부터 다시 센다', async () => {
    const { service } = fake();

    await service.next('GOODS_RECEIPT', null, DAY);

    expect(await service.next('GOODS_RECEIPT', null, '2026-09-07')).toBe('GR-20260907-0001');
  });

  it('채번 — 접두어를 모르는 문서 유형은 던진다(지어내지 않는다)', async () => {
    const { service, inserted } = fake();

    await expect(service.next('SOME_NEW_DOCUMENT', null, DAY)).rejects.toThrow('기본 접두어');
    expect(inserted).toEqual([]);
  });

  it('채번 — 모르는 토큰({PLANT})이 든 패턴은 던진다', async () => {
    const { service } = fake([rule({ pattern: 'GR-{PLANT}-{YYMMDD}-{SEQ4}' })]);

    await expect(service.next('GOODS_RECEIPT', PLANT, DAY)).rejects.toThrow('{PLANT}');
  });

  it('채번 — 밑줄이 든 토큰({PLANT_CODE})도 리터럴로 새지 않고 던진다', async () => {
    const { service } = fake([rule({ pattern: 'GR-{PLANT_CODE}-{SEQ4}' })]);

    await expect(service.next('GOODS_RECEIPT', PLANT, DAY)).rejects.toThrow('{PLANT_CODE}');
  });

  it('채번 — DAILY 가 아닌 리셋 주기는 던진다(값 목록이 없다)', async () => {
    const { service } = fake([
      rule({ pattern: 'GR-{YYYYMMDD}-{SEQ4}', reset_cycle_code: 'MONTHLY' }),
    ]);

    await expect(service.next('GOODS_RECEIPT', null, DAY)).rejects.toThrow('MONTHLY');
  });

  it('채번 — SEQ 자리를 넘으면 자르지 않고 늘어난다', async () => {
    const { service } = fake([rule({ pattern: 'GR-{SEQ1}' })]);

    for (let call = 0; call < 9; call += 1) await service.next('GOODS_RECEIPT', null, DAY);

    expect(await service.next('GOODS_RECEIPT', null, DAY)).toBe('GR-10');
  });

  it('채번 — 비활성 규칙(is_active=false)은 던진다(자동 생성으로 넘어가지 않는다)', async () => {
    const { service, inserted } = fake([
      rule({ pattern: 'GR-{YYYYMMDD}-{SEQ4}', is_active: false }),
    ]);

    await expect(service.next('GOODS_RECEIPT', null, DAY)).rejects.toThrow('비활성');
    expect(inserted).toEqual([]);
  });
});
