import { type SheetDetailRow, sheetDetailView } from './inspection-sheet-view';

/** 작성자 · 검사자 이름 — 작업자(POP 사번)가 없으면 관리웹 계정 이름(omf-all-around#316). */
function row(worker: string | null, account: string | null): SheetDetailRow {
  const at = new Date('2026-11-19T00:00:00Z');
  return {
    inspection_sheet_id: 1n,
    serial_number_id: 1n,
    serial_number: { serial_no: 'SN-1' },
    item_id: 1n,
    item: { item_code: 'I', item_name: '품목' },
    lot_id: 1n,
    lot: { lot_no: 'L' },
    work_order_id: null,
    work_order: null,
    inspection_sheet_template_id: 1n,
    status_code: 'IN_PROGRESS',
    created_at: at,
    approved_by: null,
    approved_at: null,
    checked_by: null,
    checked_at: null,
    written_worker: worker === null ? null : { worker_no: '900001', worker_name: worker },
    app_user_inspection_sheet_created_byToapp_user: account === null ? null : { user_name: account },
    app_user_inspection_sheet_approved_byToapp_user: null,
    app_user_inspection_sheet_checked_byToapp_user: null,
    template: {
      template_version: 1,
      form_layout_code: 'OP',
      lot_sources: [],
      steps: [{ step_code: 'S1', sequence_no: 1, name_ko: '공정검사1', name_vi: null, sign_required: false, items: [] }],
    },
    step_results: [
      {
        step_code: 'S1',
        first_judgment_code: 'OK',
        final_judgment_code: 'OK',
        source_code: 'SHEET',
        inspected_at: at,
        signed_by: null,
        signed_at: null,
        inspected_worker: worker === null ? null : { worker_no: '900001', worker_name: worker },
        app_user_inspection_sheet_step_result_signed_byToapp_user: null,
        app_user_inspection_sheet_step_result_updated_byToapp_user: account === null ? null : { user_name: account },
      },
    ],
    item_results: [],
    ngs: [],
    events: [],
  } as unknown as SheetDetailRow;
}

describe('sheetDetailView — 작성자 · 검사자 이름', () => {
  it.each([
    ['POP 작업자가 쓰면 작업자 이름', '작업자', null, '작업자'],
    ['관리웹 계정이 쓰면 계정 이름', null, '품질 담당', '품질 담당'],
    ['둘 다 없으면 null', null, null, null],
  ])('%s', (_, worker, account, expected) => {
    const view = sheetDetailView(row(worker, account), new Map(), [], null);

    expect(view.writtenWorkerName).toBe(expected);
    expect(view.steps[0].result?.inspectedWorkerName).toBe(expected);
  });
});
