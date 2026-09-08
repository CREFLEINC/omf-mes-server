import { PrismaService } from '../../prisma/prisma.service';
import { CalibrationIndex } from './calibration';

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const at = (value: string): Date => new Date(`${value}T09:30:00.000Z`);

interface FakeEquipment {
  equipment_id: bigint;
  calibration_due_date: Date | null;
}
interface FakeHistory {
  equipment_id: bigint;
  calibration_date: Date;
  valid_until: Date | null;
}

const indexOf = (equipments: FakeEquipment[], histories: FakeHistory[] = []): Promise<CalibrationIndex> =>
  CalibrationIndex.load({
    equipment: { findMany: () => Promise.resolve(equipments) },
    equipment_calibration: { findMany: () => Promise.resolve(histories) },
  } as unknown as PrismaService);

describe('CalibrationIndex — 교정 만료 판정(§4-4 · R-13)', () => {
  it('⭐ R-13 — `calibration_required=false` 장비는 이력이 0건이어도 만료가 아니다', async () => {
    // 마스터가 「교정 불요」로 적은 장비는 아예 후보에 안 든다(load 가 required=true 만 읽는다).
    // 계획안 본문의 「이력 0건 = 만료」를 그대로 쓰면 이 장비가 전부 만료로 잡혀 화면 경고가 상시 켜진다.
    const index = await indexOf([]);
    expect(index.expiredAt(7n, at('2026-09-02'))).toBe(false);
  });

  it('이력 0건 + 마스터 기한 없음 = 만료다 — 판정 불가를 「정상」으로 접지 않는다(L-8)', async () => {
    const index = await indexOf([{ equipment_id: 1n, calibration_due_date: null }]);
    expect(index.expiredAt(1n, at('2026-09-02'))).toBe(true);
  });

  it('이력 0건이어도 마스터 `calibration_due_date` 가 남아 있으면 그 날까지는 유효하다', async () => {
    const index = await indexOf([{ equipment_id: 1n, calibration_due_date: day('2026-09-02') }]);
    expect(index.expiredAt(1n, at('2026-09-02'))).toBe(false); // 기한 «당일»은 유효
    expect(index.expiredAt(1n, at('2026-09-03'))).toBe(true);
  });

  it('`valid_until < 측정일` 이면 만료다(당일은 유효)', async () => {
    const index = await indexOf(
      [{ equipment_id: 1n, calibration_due_date: null }],
      [{ equipment_id: 1n, calibration_date: day('2026-08-01'), valid_until: day('2026-09-01') }],
    );
    expect(index.expiredAt(1n, at('2026-09-01'))).toBe(false);
    expect(index.expiredAt(1n, at('2026-09-02'))).toBe(true);
    expect(index.expiredAt(1n, at('2026-07-31'))).toBe(true); // 검교정 «이전»도 근거가 없다
  });

  it('`valid_until` 이 비면 그 검교정 뒤로는 만료다(미발행 · I-19 §9-2 후보 9)', async () => {
    const index = await indexOf(
      [{ equipment_id: 1n, calibration_due_date: null }],
      [{ equipment_id: 1n, calibration_date: day('2026-08-01'), valid_until: null }],
    );
    expect(index.expiredAt(1n, at('2026-08-15'))).toBe(true);
  });

  it('⭐ 이력이 서면 그 뒤로는 이력이 지배한다 — 마스터 기한이 더 길어도 만료다', async () => {
    const index = await indexOf(
      [{ equipment_id: 1n, calibration_due_date: day('2026-12-31') }],
      [{ equipment_id: 1n, calibration_date: day('2026-08-01'), valid_until: day('2026-08-10') }],
    );
    expect(index.expiredAt(1n, at('2026-07-20'))).toBe(false); // 이력 이전 — 마스터가 지배
    expect(index.expiredAt(1n, at('2026-08-05'))).toBe(false);
    expect(index.expiredAt(1n, at('2026-08-11'))).toBe(true);
  });

  it('장비가 없는 측정치는 `undefined` 다 — 「만료 아님」과 뜻이 다르다(키 생략)', async () => {
    const index = await indexOf([{ equipment_id: 1n, calibration_due_date: null }]);
    expect(index.expiredAt(null, at('2026-09-02'))).toBeUndefined();
  });

  it('⛔ 교정 필요 장비가 0건이면 만료 측정치 where 가 아무 행도 안 잡는다(빈 OR 의 뜻에 안 기댄다)', async () => {
    const index = await indexOf([]);
    expect(index.expiredMeasurements()).toEqual({ inspection_equipment_id: { in: [] } });
    expect(index.measurementScope(undefined)).toEqual({}); // 기본은 섞어서 낸다(E-9 ①)
  });

  it('⚠ `exclude` 는 장비 없는 행을 «명시»로 담는다 — SQL 3값 논리가 NULL 을 통째로 버린다', async () => {
    const index = await indexOf([{ equipment_id: 1n, calibration_due_date: null }]);

    expect(index.measurementScope('exclude')).toEqual({
      OR: [{ inspection_equipment_id: null }, { NOT: index.expiredMeasurements() }],
    });
  });

  it('만료 구간을 `NOT (유효 구간)` 으로 뒤집어 DB 로 민다 — 행 판정과 필터가 같은 규칙이다', async () => {
    const index = await indexOf(
      [{ equipment_id: 1n, calibration_due_date: null }],
      [{ equipment_id: 1n, calibration_date: day('2026-08-01'), valid_until: day('2026-08-10') }],
    );
    expect(index.expiredMeasurements()).toEqual({
      OR: [{ inspection_equipment_id: 1n, NOT: { OR: [{ measured_at: { gte: day('2026-08-01'), lt: day('2026-08-11') } }] } }],
    });
  });
});
