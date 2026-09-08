import { ConcessionRow, assertUsableInvariant, concessionView } from './concession-view';

/**
 * `concession-view.ts` 단위 시험 — `usable` 4항 진리표(§4-3 · 통보 089 §2)와 널 정책(R-13).
 * ⭐⭐ §2 계열 불변식 대조(`assertUsableInvariant`)는 e2e 로는 못 잠근다(정상 구현이면 SQL 과
 * 함수가 «항상» 같은 값을 낸다 — 갈리는 자리는 코드가 실제로 어긋날 때뿐이다). 여기서 값을
 * «직접 구성»해 대조 함수가 어긋남을 실제로 잡는지 확인한다(선례 `disposition-view.spec.ts`).
 */
const ON_DATE = '2026-09-09';

const BASE_ROW: ConcessionRow = {
  concession_id: 1,
  concession_no: 'CN-0001',
  nonconformance_id: 10,
  lot_id: 20,
  approved_qty: '100.000000',
  consumed_qty: '40.000000',
  uom_id: 100,
  valid_from: new Date('2026-08-01T00:00:00.000Z'),
  valid_to: new Date('2026-09-09T00:00:00.000Z'), // ON_DATE 와 같은 날 — 경계
  allowed_work_order_id: null,
  allowed_process_id: null,
  allowed_customer_id: null,
  approval_request_id: 900,
  status_code: 'APPROVED',
  remarks: null,
  nonconformance_no: 'NC-0001',
  lot_no: 'LOT-0001',
};

describe('concessionView — usable 4항 진리표(§4-3)', () => {
  it('4항 전부 만족 — usable=true', () => {
    expect(concessionView(BASE_ROW, ON_DATE).usable).toBe(true);
  });

  it('①상태 — APPROVED 가 아니면 usable=false(나머지 3항이 전부 정상이어도)', () => {
    expect(concessionView({ ...BASE_ROW, status_code: 'REJECTED' }, ON_DATE).usable).toBe(false);
  });

  it('②valid_from — 기준일보다 «미래»면 usable=false(계약 3항에 없는 4항째 · 통보 089 §2)', () => {
    expect(concessionView({ ...BASE_ROW, valid_from: new Date('2026-09-10T00:00:00.000Z') }, ON_DATE).usable).toBe(false);
  });

  it('②valid_from — 기준일과 «같은 날»이면 usable=true(경계 포함 `<=`)', () => {
    expect(concessionView({ ...BASE_ROW, valid_from: new Date(ON_DATE) }, ON_DATE).usable).toBe(true);
  });

  it('③valid_to — 기준일보다 «하루 전」이면 usable=false', () => {
    expect(concessionView({ ...BASE_ROW, valid_to: new Date('2026-09-08T00:00:00.000Z') }, ON_DATE).usable).toBe(false);
  });

  it('③valid_to — 기준일과 «같은 날»이면 usable=true(경계 포함 `>=` · e2e C1)', () => {
    expect(concessionView({ ...BASE_ROW, valid_to: new Date(ON_DATE) }, ON_DATE).usable).toBe(true);
  });

  it('③valid_to — NULL 이면 만료가 없다(usable=true)', () => {
    expect(concessionView({ ...BASE_ROW, valid_to: null }, ON_DATE).usable).toBe(true);
  });

  it('④잔여 — 승인수량 == 소진수량(잔여 0)이면 usable=false(`> 0` 이지 `>= 0` 이 아니다)', () => {
    expect(concessionView({ ...BASE_ROW, approved_qty: '50.000000', consumed_qty: '50.000000' }, ON_DATE).usable).toBe(false);
  });
});

describe('concessionView — unrestrictedAxes(통보 089 §3)', () => {
  it('허용 3축이 전부 NULL 이면 3개 전부 — 계약 프로퍼티 이름 그대로', () => {
    expect(concessionView(BASE_ROW, ON_DATE).unrestrictedAxes).toEqual(['allowedWorkOrderId', 'allowedProcessId', 'allowedCustomerId']);
  });

  it('한 축만 차면 나머지 2개만', () => {
    const view = concessionView({ ...BASE_ROW, allowed_customer_id: 500 }, ON_DATE);
    expect(view.unrestrictedAxes).toEqual(['allowedWorkOrderId', 'allowedProcessId']);
  });
});

describe('concessionView — R-13 널 정책(§1-4-0)', () => {
  it('선택 칸이 NULL 이면 키를 생략한다(널이 아니다)', () => {
    const view = concessionView(BASE_ROW, ON_DATE);
    for (const key of ['validTo', 'remarks', 'allowedWorkOrderId', 'allowedProcessId', 'allowedCustomerId']) {
      // BASE_ROW 는 valid_to 를 채웠으므로 remarks·allowed* 만 생략된다.
      if (key === 'validTo') continue;
      expect(view).not.toHaveProperty(key);
    }
    expect(view).not.toHaveProperty('versionNo'); // 아예 싣지 않는다
  });

  it('validTo 가 NULL 이면 키를 생략한다', () => {
    const view = concessionView({ ...BASE_ROW, valid_to: null }, ON_DATE);
    expect(view).not.toHaveProperty('validTo');
  });
});

describe('assertUsableInvariant — §2 런타임 대조', () => {
  it('usableOnly 가 없으면(undefined) 절대 던지지 않는다', () => {
    expect(() => assertUsableInvariant(undefined, [{ concessionId: 1, usable: false }])).not.toThrow();
  });

  it('usableOnly=true 이고 반환된 모든 행이 usable=true 면 통과한다', () => {
    expect(() => assertUsableInvariant(true, [{ concessionId: 1, usable: true }])).not.toThrow();
  });

  it('⭐⭐ usableOnly=true 인데 반환된 행이 usable=false — 던진다', () => {
    expect(() => assertUsableInvariant(true, [{ concessionId: 1, usable: false }])).toThrow(/#1/);
  });

  it('⭐ 여러 행 중 «둘째»만 어긋나도 던진다(첫 행만 보면 못 잡는다)', () => {
    const rows = [
      { concessionId: 1, usable: true },
      { concessionId: 2, usable: false },
    ];
    expect(() => assertUsableInvariant(true, rows)).toThrow(/#2/);
  });
});
