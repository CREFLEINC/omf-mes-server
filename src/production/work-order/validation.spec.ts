import {
  EquipmentFacts,
  MoldFacts,
  RivalWindow,
  ValidationFinding,
  checkCalibration,
  checkDoubleBooked,
  checkEquipment,
  checkMoldLife,
  checkQualification,
  summarize,
} from './validation';

/**
 * 규칙 여섯의 판정만 본다 — DB 목 없이 순수 함수에 행을 넣는다. 적재(`validateWorkOrder`)는
 * e2e 가 덮는다.
 */

const TODAY = new Date(Date.UTC(2026, 8, 6));

function equipment(overrides: Partial<EquipmentFacts> = {}): EquipmentFacts {
  return {
    equipment_id: 1n,
    status_code: 'IN_SERVICE',
    is_active: true,
    calibration_required: false,
    calibration_due_date: null,
    ...overrides,
  };
}

function mold(overrides: Partial<MoldFacts> = {}): MoldFacts {
  return {
    mold_id: 1n,
    status_code: 'IN_SERVICE',
    is_active: true,
    guaranteed_shot_count: null,
    current_shot_count: 0n,
    ...overrides,
  };
}

const codes = (findings: ValidationFinding[]): string[] => findings.map((item) => item.code);

describe('4M 유효성 점검', () => {
  it('점검 — 설비 비가동은 BLOCK, 교정 만료는 WARN 이다', () => {
    const stopped = equipment({ equipment_id: 7n, status_code: 'DISPOSED' });
    const expired = equipment({
      equipment_id: 8n,
      calibration_required: true,
      calibration_due_date: new Date(Date.UTC(2026, 8, 5)),
    });
    const facts = new Map([
      [7n, stopped],
      [8n, expired],
    ]);

    const blocks = checkEquipment([7n, 8n], facts);
    const warns = checkCalibration([7n, 8n], facts, TODAY);

    expect(blocks).toEqual([
      { severity: 'BLOCK', field: 'plannedEquipmentId', code: 'EQUIPMENT_NOT_IN_SERVICE', message: expect.any(String) },
    ]);
    expect(warns).toEqual([
      { severity: 'WARN', field: 'plannedEquipmentId', code: 'EQUIPMENT_CALIBRATION_EXPIRED', message: expect.any(String) },
    ]);
    // 기한이 「오늘」이면 아직 지나지 않았다 — `@db.Date` 의 UTC 자정끼리 비교한다.
    expect(checkCalibration([8n], new Map([[8n, equipment({ equipment_id: 8n, calibration_required: true, calibration_due_date: TODAY })]]), TODAY)).toEqual([]);
    // 교정 대상이 아니면 기한이 비어 있어도 아무 말도 하지 않는다.
    expect(checkCalibration([7n], facts, TODAY)).toEqual([]);
  });

  it('점검 — `passed` 는 BLOCK 0 이면 참이고 WARN 은 안 본다', () => {
    const warns: ValidationFinding[] = [
      { severity: 'WARN', field: 'plannedMoldId', code: 'MOLD_LIFE_EXCEEDED', message: '금형 수명' },
      { severity: 'WARN', field: 'responsibleWorkerId', code: 'WORKER_QUALIFICATION_EXPIRED', message: '자격' },
    ];

    expect(summarize({ passed: true, findings: warns })).toEqual({ passed: true, blockCount: 0, warnCount: 2 });
    expect(
      summarize({
        passed: false,
        findings: [...warns, { severity: 'BLOCK', field: 'plannedEquipmentId', code: 'EQUIPMENT_NOT_IN_SERVICE', message: '설비' }],
      }),
    ).toEqual({ passed: false, blockCount: 1, warnCount: 2 });
  });

  it('점검 — 두 배정 축(단일 칸·배정 표)을 합집합으로 본다', () => {
    // 단일 칸의 금형 3 + 배정 표의 금형 4·3 — 3 은 한 번만 센다.
    const ids = [3n, 4n];
    const facts = new Map([
      [3n, mold({ mold_id: 3n, guaranteed_shot_count: 100n, current_shot_count: 100n })],
      [4n, mold({ mold_id: 4n, status_code: 'DISPOSED' })],
    ]);

    expect(codes(checkMoldLife(ids, facts))).toEqual(['MOLD_LIFE_EXCEEDED']);
    // 배정 표에서 온 자원도 `field` 는 단일 칸 이름 그대로다 — 계약 `field` 는 요청 칸 이름이다.
    expect(checkMoldLife(ids, facts)[0].field).toBe('plannedMoldId');
    // 마스터에 없는 id 도 BLOCK 이다(FK 상 없을 수 없지만 조용히 통과시키지 않는다).
    expect(codes(checkEquipment([9n], new Map()))).toEqual(['EQUIPMENT_NOT_IN_SERVICE']);
  });

  it('점검 — `planned_end_at` 이 없으면 중복 배정을 판정하지 않는다', () => {
    const rival: RivalWindow = {
      planned_equipment_id: 5n,
      planned_start_at: new Date('2026-09-06T00:00:00.000Z'),
      planned_end_at: new Date('2026-09-06T12:00:00.000Z'),
    };
    const self = { planned_start_at: new Date('2026-09-06T06:00:00.000Z'), planned_end_at: new Date('2026-09-06T18:00:00.000Z') };

    expect(codes(checkDoubleBooked([5n], self, [rival]))).toEqual(['EQUIPMENT_DOUBLE_BOOKED']);
    // 자기 W/O 의 끝이 없으면 판정하지 않는다.
    expect(checkDoubleBooked([5n], { ...self, planned_end_at: null }, [rival])).toEqual([]);
    // 상대의 끝이 없어도 판정하지 않는다.
    expect(checkDoubleBooked([5n], self, [{ ...rival, planned_end_at: null }])).toEqual([]);
    // 반열림 구간 — 맞닿기만 하면 겹침이 아니다.
    expect(checkDoubleBooked([5n], { planned_start_at: rival.planned_end_at, planned_end_at: new Date('2026-09-06T18:00:00.000Z') }, [rival])).toEqual([]);
  });

  it('점검 — 자격은 `routing_operation.process_id` 로 맞춘다', () => {
    // 적재 질의가 그 공정의 유효 자격만 담아 오므로 판정은 「그 집합에 있나」다.
    // ⛔ `process_id IS NULL` 인 자격 행은 그 집합에 «들지 않는다»(전 공정으로 치지 않는다).
    const qualified = new Set([11n]);

    expect(checkQualification([11n, 12n], qualified)).toEqual([
      { severity: 'WARN', field: 'responsibleWorkerId', code: 'WORKER_QUALIFICATION_EXPIRED', message: expect.any(String) },
    ]);
    expect(checkQualification([11n], qualified)).toEqual([]);
  });
});
