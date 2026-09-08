import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** `@db.Date` 는 UTC 자정으로 온다. 유효기한 «당일»은 유효라 반열림 구간의 끝은 하루 뒤다. */
const DAY_MS = 86_400_000;
const dayOf = (value: Date): number => Math.floor(value.getTime() / DAY_MS);

/** 교정이 유효한 반열림 구간 `[from, until)` — 날짜 일련번호. `from=null` 은 「이력 이전 전부」. */
interface Window {
  from: number | null;
  until: number;
}

export type CalibrationExpiredFilter = 'only' | 'exclude';

/**
 * ⭐ R-13 — 교정 만료 판정은 **장비 마스터 두 칸을 먼저 본다**(`equipment.calibration_required`·
 * `calibration_due_date`). 화면 정본 `W-03-05` §5-6 이 판별 근거로 그 둘과 이력 표를 «함께» 적었다.
 * 계획안 본문의 「검교정 이력 0건 = 만료」를 그대로 쓰면 **교정이 필요 없는 장비가 전부 만료**로
 * 잡혀 §5-6 의 경고와 「분리해 보기」가 상시 켜진다.
 *
 * 규칙 — ⓐ `calibration_required=false` 면 **언제나 만료가 아니다** ⓑ 이력이 서면 그 뒤로는
 * **가장 최근 검교정이 지배**한다(`valid_until`) ⓒ 이력 이전(이력 0건 포함)은 마스터
 * `calibration_due_date` 가 지배한다 ⓓ 지배하는 날짜가 아예 없으면 **만료**다 — 판정 불가를
 * 정상으로 접지 않는다(`plan.md` §5-10 · L-8).
 * ⚠ 날짜 축은 **UTC** 다 — 측정치·결과에 공장 칸이 없어 `plant.timezone_code` 로 풀 자리가 없다
 *   (`defect-rate-trend` 의 버킷 축과 같은 계열 · 「알려둘 것」).
 */
export class CalibrationIndex {
  private constructor(private readonly windows: Map<string, Window[]>) {}

  /**
   * 교정이 필요한 장비 전건 + 그 이력을 두 번에 나눠 읽는다. 장비는 mdm 규모(수백)라 요청마다
   * 훑어도 되고, 금지된 것은 측정치(135,000 자릿수)를 건별로 도는 N+1 이다(L-2 · §4-4).
   */
  static async load(prisma: PrismaService): Promise<CalibrationIndex> {
    const equipments = await prisma.equipment.findMany({
      where: { calibration_required: true },
      select: { equipment_id: true, calibration_due_date: true },
    });
    const histories = await prisma.equipment_calibration.findMany({
      where: { equipment_id: { in: equipments.map((equipment) => equipment.equipment_id) } },
      orderBy: { calibration_date: 'asc' },
      select: { equipment_id: true, calibration_date: true, valid_until: true },
    });

    const byEquipment = new Map<string, { from: number; until: number | null }[]>();
    for (const row of histories) {
      const key = row.equipment_id.toString();
      const record = { from: dayOf(row.calibration_date), until: row.valid_until === null ? null : dayOf(row.valid_until) };
      byEquipment.set(key, [...(byEquipment.get(key) ?? []), record]);
    }
    return new CalibrationIndex(
      new Map(
        equipments.map((equipment) => {
          const key = equipment.equipment_id.toString();
          return [key, coveredWindows(equipment.calibration_due_date, byEquipment.get(key) ?? [])] as const;
        }),
      ),
    );
  }

  /**
   * 「측정 시점에 이 장비의 교정이 만료였는가」 — 서버가 판정한다(계약 L-2).
   * 장비가 없는 측정치는 `undefined` 다 — 「만료 아님(false)」과 뜻이 달라 키를 생략한다(§5-7).
   */
  expiredAt(equipmentId: bigint | null, measuredAt: Date): boolean | undefined {
    if (equipmentId === null) return undefined;
    const windows = this.windows.get(equipmentId.toString());
    if (windows === undefined) return false; // 교정 불요 장비 — R-13 ⓐ
    const day = dayOf(measuredAt);
    return !windows.some((window) => (window.from === null || day >= window.from) && day < window.until);
  }

  /** 만료 측정치를 가리키는 where. 같은 규칙을 DB 로 밀어 행 판정과 필터가 갈리지 않게 한다. */
  expiredMeasurements(): Prisma.inspection_measurementWhereInput {
    const clauses = [...this.windows].map(([equipmentId, windows]) => ({
      inspection_equipment_id: BigInt(equipmentId),
      ...(windows.length === 0 ? {} : { NOT: { OR: windows.map(rangeOf) } }),
    }));
    // 교정 필요 장비가 0건이면 만료 측정치도 0건이다 — 빈 `OR` 의 뜻에 기대지 않는다.
    return clauses.length === 0 ? { inspection_equipment_id: { in: [] } } : { OR: clauses };
  }

  /**
   * 측정치 축 필터. ⛔ 기본(생략)은 **섞어서** 낸다 — 자동 제외는 정책 미정이다(E-9 ①).
   * ⚠ `exclude` 에 장비가 없는 행을 «명시»로 더한다 — `NOT (equipment_id = X AND …)` 는 SQL
   *   3값 논리에서 `equipment_id IS NULL` 이면 UNKNOWN 이라 행이 통째로 사라진다. 육안 항목
   *   (장비 없음)은 만료가 아니므로 남아야 한다.
   */
  measurementScope(mode?: CalibrationExpiredFilter): Prisma.inspection_measurementWhereInput {
    if (mode === undefined) return {};
    if (mode === 'only') return this.expiredMeasurements();
    return { OR: [{ inspection_equipment_id: null }, { NOT: this.expiredMeasurements() }] };
  }

  /** 결과 축 필터 — `only` 는 만료 측정치가 «있는» 결과, `exclude` 는 «없는» 결과. */
  resultScope(mode?: CalibrationExpiredFilter): Prisma.inspection_resultWhereInput {
    if (mode === undefined) return {};
    const expired = this.expiredMeasurements();
    return { inspection_measurement: mode === 'only' ? { some: expired } : { none: expired } };
  }
}

/** ⓑⓒ 를 한 목록으로 편다 — 이력이 서는 날부터는 이력이, 그 앞은 마스터 기한이 지배한다. */
function coveredWindows(dueDate: Date | null, history: { from: number; until: number | null }[]): Window[] {
  const firstRecord = history[0]?.from;
  const windows: Window[] = [];
  if (dueDate !== null) windows.push({ from: null, until: Math.min(dayOf(dueDate) + 1, firstRecord ?? Number.MAX_SAFE_INTEGER) });
  history.forEach((record, index) => {
    if (record.until === null) return; // 유효기한 없는 검교정 = 그 뒤로 만료(§4-4 · 문의 후보 069+9)
    windows.push({ from: record.from, until: Math.min(record.until + 1, history[index + 1]?.from ?? Number.MAX_SAFE_INTEGER) });
  });
  return windows.filter((window) => window.until > (window.from ?? Number.MIN_SAFE_INTEGER));
}

const rangeOf = (window: Window): Prisma.inspection_measurementWhereInput => ({
  measured_at: {
    ...(window.from === null ? {} : { gte: new Date(window.from * DAY_MS) }),
    lt: new Date(window.until * DAY_MS),
  },
});
