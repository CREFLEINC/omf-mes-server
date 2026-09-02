/**
 * 전이표가 «시드된 코드 값»과 어긋나지 않는지 실 DB 로 지킨다.
 * 코드가 `'ACTIVE'` 라 적고 시드가 다른 값을 넣으면 조용히 갈린다 — 전이는 그때 안 열린다.
 */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { DocumentStateService } from '../src/core/document-state';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('전표 상태기계 ↔ 시드 (실 DB)', () => {
  let prisma: PrismaService;
  const service = new DocumentStateService();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }), PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function activeCodes(groupCode: string): Promise<string[]> {
    const values = await prisma.code_value.findMany({
      where: { code_group: { group_code: groupCode }, is_active: true },
      select: { code: true },
    });
    return values.map((value) => value.code).sort();
  }

  /**
   * 상태 칸마다 값 목록을 가진 코드 그룹이 따로 있다. 여기 없는 축이 전이표에 생기면
   * 아래 검사가 「어느 그룹으로 볼지 모른다」로 깨진다 — 그것이 이 표의 뜻이다.
   */
  const STATUS_GROUPS: Record<string, string> = {
    'trace.lot.lifecycle_status_code': 'LOT_LIFECYCLE_STATUS',
    'mdm.equipment.status_code': 'EQUIPMENT_STATUS',
    // ⚠ 확정의 코드 문자열이 `ACTIVE` 다 — 계약이 이름을 되돌리라 적었으나 값 집합은
    // 정해져 있다(되돌림 §S-1). 이름이 바뀌면 이 검사가 먼저 깨진다.
    'planning.routing.status_code': 'REVISION_STATUS',
  };

  it('⭐ 전이표가 쓰는 상태가 축마다의 코드 그룹에 전부 있다', async () => {
    const missing: string[] = [];
    for (const entry of service.registered()) {
      const groupCode = STATUS_GROUPS[entry.column];
      if (groupCode === undefined) {
        missing.push(`${entry.column}: 코드 그룹이 이 검사에 등록되지 않았다`);
        continue;
      }
      const seeded = new Set(await activeCodes(groupCode));
      for (const code of [...entry.transition.from, entry.transition.to]) {
        if (!seeded.has(code)) missing.push(`${entry.column}/${code} — ${groupCode} 에 없다`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('⭐ 전이 코드가 LOT_LIFECYCLE_TRANSITION 에 전부 있다', async () => {
    const seeded = new Set(await activeCodes('LOT_LIFECYCLE_TRANSITION'));
    const used = service
      .registered()
      .map((entry) => entry.transition.transitionCode)
      .filter((code): code is string => code !== undefined);

    expect(used.filter((code) => !seeded.has(code))).toEqual([]);
    // 시드된 셋을 다 쓴다 — 하나라도 안 쓰면 그 전이를 여는 자리가 없다는 뜻이다.
    expect(used.sort()).toEqual([...seeded].sort());
  });

  it('⛔ 품질 판정 축은 아직 등록할 수 없다 — 전이가 가리키는 상태가 값 목록에 없다', async () => {
    const statuses = new Set(await activeCodes('LOT_STATUS'));
    const transitions = await prisma.code_value.findMany({
      where: { code_group: { group_code: 'LOT_STATUS_TRANSITION' }, is_active: true },
      select: { code_name: true },
    });

    // 전이 이름은 「A → B」 꼴이고 B 가 도착 상태다. 그 이름들이 LOT_STATUS 값과 맞지 않는다.
    const targets = transitions.map((row) => row.code_name.split(' → ')[1]);
    expect(targets.some((target) => target?.includes('PQC'))).toBe(true);
    expect([...statuses].some((code) => code.includes('PQC'))).toBe(false);
  });

  it('전이가 남길 자리가 실재한다 — lot_lifecycle_history.transition_code', async () => {
    const column = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'trace' AND table_name = 'lot_lifecycle_history'
         AND column_name = 'transition_code'`;

    expect(Number(column[0].count)).toBe(1);
  });
});
