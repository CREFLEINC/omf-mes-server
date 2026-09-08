import { REPAIR_EXECUTION_ORDER_BY } from './repair-execution-query.service';
import { RepairExecutionRow, repairExecutionView } from './repair-execution-view';

function row(overrides: Partial<RepairExecutionRow> = {}): RepairExecutionRow {
  return {
    repair_execution_id: 1n,
    defect_record_id: 100n,
    repair_process_id: null,
    started_at: new Date('2026-09-08T01:00:00.000Z'),
    returned_at: null,
    repair_qty: '40.5' as unknown as RepairExecutionRow['repair_qty'],
    uom_id: 200n,
    repair_result_code: null,
    reintroduced_lot_id: null,
    terminal_id: null,
    worker_no: null,
    created_at: new Date('2026-09-08T01:00:00.000Z'),
    created_by: null,
    ...overrides,
  } as unknown as RepairExecutionRow;
}

describe('repairExecutionView', () => {
  it('널 허용 6칸(repairProcessId·returnedAt·repairResultCode·reintroducedLotId·terminalId·workerNo)이 비면 키를 생략한다', () => {
    const view = repairExecutionView(row());
    expect('repairProcessId' in view).toBe(false);
    expect('returnedAt' in view).toBe(false);
    expect('repairResultCode' in view).toBe(false);
    expect('reintroducedLotId' in view).toBe(false);
    expect('terminalId' in view).toBe(false);
    expect('workerNo' in view).toBe(false);
  });

  it('널 허용 6칸에 값이 있으면 그대로 싣는다', () => {
    const view = repairExecutionView(
      row({
        repair_process_id: 30n,
        returned_at: new Date('2026-09-08T05:00:00.000Z'),
        repair_result_code: 'SUCCEEDED',
        reintroduced_lot_id: 40n,
        terminal_id: 50n,
        worker_no: '100027',
      }),
    );
    expect(view).toMatchObject({
      repairProcessId: 30,
      returnedAt: '2026-09-08T05:00:00.000Z',
      repairResultCode: 'SUCCEEDED',
      reintroducedLotId: 40,
      terminalId: 50,
      workerNo: '100027',
    });
  });

  it('Decimal(repair_qty) 이 소수를 보존한 number 로 바뀐다', () => {
    const view = repairExecutionView(row({ repair_qty: '40.5' as unknown as RepairExecutionRow['repair_qty'] }));
    expect(view.repairQty).toBe(40.5);
    expect(typeof view.repairQty).toBe('number');
  });

  it('계약 11칸만 낸다(널 6칸이 비었을 때)', () => {
    const view = repairExecutionView(row());
    expect(Object.keys(view).sort()).toEqual([
      'defectRecordId',
      'repairExecutionId',
      'repairQty',
      'startedAt',
      'uomId',
    ]);
  });
});

describe('REPAIR_EXECUTION_ORDER_BY', () => {
  it('started_at desc + repair_execution_id desc 로 고정된다(구간형 open 목록 선례)', () => {
    expect(REPAIR_EXECUTION_ORDER_BY).toEqual([
      { started_at: 'desc' },
      { repair_execution_id: 'desc' },
    ]);
  });
});
