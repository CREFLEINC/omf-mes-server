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
    // 툴도 같은 그룹을 쓴다 — 계약이 「설비·툴·계측기가 같은 규칙」이라 적었다.
    'mdm.mold.status_code': 'EQUIPMENT_STATUS',
    'planning.routing.status_code': 'MASTER_VERSION_STATUS',
    // ⚠ I-1 이 결재 축을 열면서 이 표에 안 실어 검사가 「등록되지 않았다」로 이미 붉었다.
    'app.approval_request.status_code': 'APPROVAL_REQUEST_STATUS',
    'logistics.goods_issue.status_code': 'LOGISTICS_DOCUMENT_STATUS',
    // 입하·입고는 출고와 같은 그룹을 쓴다 — 세 유형이 한 취소 경로를 탄다.
    'logistics.inbound_receipt.status_code': 'LOGISTICS_DOCUMENT_STATUS',
    'logistics.goods_receipt.status_code': 'LOGISTICS_DOCUMENT_STATUS',
    'logistics.putaway_task.status_code': 'PUTAWAY_TASK_STATUS',
    'production.work_order.status_code': 'WORK_ORDER_STATUS',
    'production.work_session.status_code': 'WORK_SESSION_STATUS',
    'planning.production_plan.status_code': 'PRODUCTION_PLAN_STATUS',
    'maintenance.breakdown.status_code': 'EQUIPMENT_BREAKDOWN_STATUS',
    // 같은 표의 생명주기 축과 «다른 그룹»이다 — 한 필드에 섞지 말라고 설계가 못박은 자리.
    'trace.lot.status_code': 'LOT_STATUS',
    'quality.inspection_result.status_code': 'INSPECTION_RESULT_STATUS',
  };

  /**
   * 이력 칸(`transition_code`)을 가진 축과 그 코드 그룹. 축마다 그룹이 다르다 —
   * 생명주기는 `L1~L3`, 품질 판정은 `C4~C15` 이고 둘을 한 집합으로 세면 안 된다.
   */
  const TRANSITION_CODE_GROUPS: Record<string, string> = {
    'trace.lot.lifecycle_status_code': 'LOT_LIFECYCLE_TRANSITION',
    'trace.lot.status_code': 'LOT_STATUS_TRANSITION',
  };

  /**
   * 시드에 있으나 «일부러» 열지 않은 전이 코드. 비워 두는 것도 판정이라 목록으로 적는다 —
   * 이 표가 「안 연다」와 「빠뜨렸다」를 가른다.
   */
  const UNOPENED_TRANSITION_CODES: Record<string, string[]> = {
    // C15(전수 재검 양품)는 C4 와 (from, to) 가 같은데 어느 LOT 이 C14 로 그 자리에 왔는지
    // 가릴 표식이 데이터에 없다 — 지어내지 않는다(F-6 · 미발행 · I-19 §9-2 후보 8).
    'trace.lot.status_code': ['C15'],
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

  it('⭐ 전이 코드가 축마다의 코드 그룹에 전부 있고, 안 쓰는 코드는 적어 둔 것뿐이다', async () => {
    for (const [column, groupCode] of Object.entries(TRANSITION_CODE_GROUPS)) {
      const seeded = await activeCodes(groupCode);
      const used = service
        .registered()
        .filter((entry) => entry.column === column)
        .map((entry) => entry.transition.transitionCode)
        .filter((code): code is string => code !== undefined);

      // ⭐ #292 리뷰 M-1 — 축별로 가르면서 «중복» 탐지를 잃었다. 옛 단언은 다중집합 비교라 한
      // 코드가 두 액션에 붙으면 깨졌는데, 아래 집합차는 중복을 못 본다.
      expect([...new Set(used)]).toHaveLength(used.length);
      expect(used.filter((code) => !seeded.includes(code))).toEqual([]);
      // 시드된 셋을 다 쓴다 — 안 쓰는 것은 그 전이를 여는 자리가 없다는 뜻이라 위 표가 이름 적는다.
      expect(seeded.filter((code) => !used.includes(code))).toEqual(
        UNOPENED_TRANSITION_CODES[column] ?? [],
      );
    }
  });

  it('⛔ 코드 그룹을 안 적은 축은 이력에 전이 코드를 싣지 않는다', () => {
    // 축을 걸러 세게 됐으므로, 그룹을 안 적은 축이 코드를 갖고 조용히 빠지는 길을 막는다.
    const columns = service
      .registered()
      .filter((entry) => entry.transition.transitionCode !== undefined)
      .map((entry) => entry.column);

    expect([...new Set(columns)].sort()).toEqual(Object.keys(TRANSITION_CODE_GROUPS).sort());
  });

  it('⭐ 품질 판정 축을 등록했다 — 「PQC 검사 필요」는 상태값이 아니라 검사 대기다', async () => {
    const statuses = await activeCodes('LOT_STATUS');
    const transitions = await prisma.code_value.findMany({
      where: { code_group: { group_code: 'LOT_STATUS_TRANSITION' }, is_active: true },
      select: { code: true, code_name: true },
    });

    // 이 축을 오래 비워 둔 이유가 여기 있었다 — 전이 이름은 「A → B」 꼴이고 B 가 도착
    // 상태인데, C14 의 B(「PQC 검사 필요」)가 LOT_STATUS 값 목록에 없다. 회신 E-3 종결
    // (2026-08-07)이 그것을 `INSPECTION_PENDING` 에 합치며 풀었다 — 시드 이름은 그대로라
    // 합침이 코드에 살아 있는지 여기서 지킨다.
    const c14 = transitions.find((row) => row.code === 'C14')?.code_name.split(' → ')[1];
    expect(c14).toContain('PQC');
    expect(statuses.some((code) => code.includes('PQC'))).toBe(false);
    expect(
      service.assertTransition('trace.lot.status_code', 'pqc-acceptance-exceeded', 'NORMAL').to,
    ).toBe('INSPECTION_PENDING');
  });

  it('전이가 남길 자리가 실재한다 — 축마다 이력 표가 다르다', async () => {
    // 품질 판정 축은 `lot_status_event` 가 받는다. 그 칸이 NOT NULL 이라 코드 없는 전이
    // (재등록 · 문의 089 · 발행 예정)는 이 표에 실릴 수 없다.
    const columns = await prisma.$queryRaw<{ table_name: string; is_nullable: string }[]>`
      SELECT table_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'trace' AND column_name = 'transition_code'
         AND table_name IN ('lot_lifecycle_history', 'lot_status_event')
       ORDER BY table_name`;

    expect(columns.map((row) => row.table_name)).toEqual([
      'lot_lifecycle_history',
      'lot_status_event',
    ]);
    expect(columns.map((row) => row.is_nullable)).toEqual(['NO', 'NO']);
  });
});
