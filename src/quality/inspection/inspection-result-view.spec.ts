import { Prisma } from '@prisma/client';

import { InspectionResultRow, inspectionResultView } from './inspection-result-view';

function resultRow(overrides: Partial<InspectionResultRow> = {}): InspectionResultRow {
  return {
    inspection_result_id: 1n,
    inspection_result_no: 'IRS-2026-0907-0001',
    inspection_request_id: 11n,
    inspection_round: 1,
    inspected_qty: new Prisma.Decimal(100),
    accepted_qty: new Prisma.Decimal(100),
    rejected_qty: new Prisma.Decimal(0),
    held_qty: new Prisma.Decimal(0),
    uom_id: 21n,
    overall_judgment_code: 'ACCEPTED',
    inspector_id: 31n,
    inspected_at: new Date('2026-09-07T01:00:00.000Z'),
    confirmed_at: new Date('2026-09-07T01:05:00.000Z'),
    terminal_id: null,
    status_code: 'CONFIRMED',
    previous_result_id: null,
    reinspection_reason_code: null,
    idempotency_key: 'idem-1',
    remarks: null,
    created_at: new Date('2026-09-07T00:00:00.000Z'),
    created_by: null,
    updated_at: new Date('2026-09-07T00:00:00.000Z'),
    updated_by: null,
    version_no: 1,
    inspection_request: {
      inspection_request_no: 'IR-2026-0907-0001',
      inspection_type_code: 'IQC',
      item_id: 41n,
      lot_id: 51n,
      lot: { lot_no: 'LOT-0001' },
      work_order: null,
      inspection_plan_version: null,
    },
    ...overrides,
  };
}

describe('InspectionResult 뷰', () => {
  it('값 없는 칸은 키를 생략한다(널을 안 보낸다) — [type,null] 파생 3칸도 같다', () => {
    const view = inspectionResultView(resultRow());

    for (const key of ['terminalId', 'previousResultId', 'reinspectionReasonCode', 'remarks']) {
      expect(Object.keys(view)).not.toContain(key);
    }
    // 확정 결과는 confirmedAt 이 찬다 — 값 있는 칸은 그대로 낸다는 것도 함께 본다.
    expect(view.confirmedAt).toBe('2026-09-07T01:05:00.000Z');
    // ⭐ #294 M-1 — [type,null] 파생인 processId·processName 도 값이 없으면(work_order·기준
    // 둘 다 없는 기본 픽스처) §5-7 기본대로 키를 생략한다(null 을 안 싣는다). `lotNo` 는
    // 기본 픽스처가 LOT 을 갖고 있어 별도 테스트로 갈랐다(바로 아래).
    for (const key of ['processId', 'processName']) {
      expect(Object.keys(view)).not.toContain(key);
    }
    expect(view).toMatchObject({ inspectionResultId: 1, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED' });
  });

  it('⭐ DRAFT + 판정 없음 — overallJudgmentCode 는 키를 생략한다(선례 054 와 같은 모양)', () => {
    const view = inspectionResultView(resultRow({ status_code: 'DRAFT', overall_judgment_code: null, confirmed_at: null }));

    // 계약 required 인데 물리는 M-e ⓒ로 nullable 이다 — 값을 지어내지 않고(F-6) 선례
    // (material-consumption-view.ts `terminalId`)처럼 키를 생략한다(문의 085).
    expect(view).not.toHaveProperty('overallJudgmentCode');
    expect(view.statusCode).toBe('DRAFT');
    expect(view).not.toHaveProperty('confirmedAt');
  });

  it('lotNo 는 의뢰의 LOT 조인에서 파생한다', () => {
    const withLot = inspectionResultView(resultRow());
    expect(withLot.lotNo).toBe('LOT-0001');

    const withoutLot = inspectionResultView(
      resultRow({ inspection_request: { ...resultRow().inspection_request, lot_id: null, lot: null } }),
    );
    expect(withoutLot).not.toHaveProperty('lotNo');
  });

  it('processId — ⓑ W/O 축을 ⓐ 기준 축보다 먼저 본다(§2-3)', () => {
    const withBoth = inspectionResultView(
      resultRow({
        inspection_request: {
          ...resultRow().inspection_request,
          work_order: { routing_operation: { process: { process_id: 71n, process_name: '사출' } } },
          inspection_plan_version: {
            inspection_plan: { process: { process_id: 72n, process_name: '검사기준공정' } },
          },
        },
      }),
    );
    expect(withBoth).toMatchObject({ processId: 71, processName: '사출' });
  });

  it('processId — ⓑ 가 비면 ⓐ 기준 축으로 떨어진다(PQC·OQC — work_order 가 없다)', () => {
    const withPlanOnly = inspectionResultView(
      resultRow({
        inspection_request: {
          ...resultRow().inspection_request,
          work_order: null,
          inspection_plan_version: { inspection_plan: { process: { process_id: 72n, process_name: '검사기준공정' } } },
        },
      }),
    );
    expect(withPlanOnly).toMatchObject({ processId: 72, processName: '검사기준공정' });
  });

  it('processId — 둘 다 없으면 키를 생략한다(가짜 값을 짓지 않는다)', () => {
    const neither = inspectionResultView(resultRow());
    expect(neither).not.toHaveProperty('processId');
    expect(neither).not.toHaveProperty('processName');
  });
});
