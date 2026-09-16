import {
  POP_SCREEN_REQUIREMENTS,
  TerminalProcessFlags,
  accessibleScreenCodes,
} from './terminal-accessible-screens';

const NONE: TerminalProcessFlags = {
  can_start_work: false,
  can_input_material: false,
  can_input_result: false,
  can_input_inspection: false,
  can_print_label: false,
  can_complete_work: false,
};

/** 축이 없어 언제나 담기는 화면 — 매핑이 0행이어도 이만큼은 나온다. */
const ALWAYS = ['P-01-01', 'P-02-12', 'P-05-01', 'P-05-02'];

const flags = (on: Partial<TerminalProcessFlags>): TerminalProcessFlags => ({ ...NONE, ...on });

describe('POP 화면 이동 후보 (D3)', () => {
  it('⛔ 공정 매핑이 0행이면 축 없는 화면만 나온다 — 「매핑 없음」을 「무엇이든 됨」으로 읽지 않는다', () => {
    expect(accessibleScreenCodes([])).toEqual(ALWAYS);
  });

  it('⛔ 플래그가 전부 거짓인 행이 있어도 축 없는 화면만 나온다', () => {
    expect(accessibleScreenCodes([NONE])).toEqual(ALWAYS);
  });

  it.each([
    ['can_start_work', ['P-02-01', 'P-02-10']],
    ['can_input_material', ['P-02-03', 'P-02-11']],
    ['can_input_result', ['P-02-04', 'P-04-03']],
    ['can_input_inspection', ['P-02-13']],
    ['can_print_label', ['P-01-02', 'P-02-09', 'P-04-04', 'P-04-05']],
    ['can_complete_work', ['P-02-08', 'P-04-01']],
  ] as const)('%s 하나만 켜면 그 화면들만 더 나온다', (flag, expected) => {
    const codes = accessibleScreenCodes([flags({ [flag]: true })]);

    expect(codes.filter((code) => !ALWAYS.includes(code))).toEqual(expected);
    // 순서는 카탈로그 순서 그대로다 — 버튼 자리가 화면마다 흔들리면 작업자가 외울 수 없다.
    expect(codes).toEqual(POP_SCREEN_REQUIREMENTS.map((row) => row.code).filter((code) => codes.includes(code)));
  });

  it('⭐ 공정 행이 여럿이면 «하나라도» 참인 플래그를 모은다', () => {
    const codes = accessibleScreenCodes([
      flags({ can_start_work: true }),
      flags({ can_input_result: true }),
    ]);

    expect(codes).toEqual(expect.arrayContaining(['P-02-01', 'P-02-10', 'P-02-04', 'P-04-03']));
    expect(codes).not.toContain('P-02-03');
  });

  it('WIP-CHAIN-01 의 단말 10 구성(시작·투입·실적·라벨)이면 작업 사슬 화면이 전부 나온다', () => {
    const codes = accessibleScreenCodes([
      flags({
        can_start_work: true, can_input_material: true,
        can_input_result: true, can_print_label: true,
      }),
    ]);

    for (const code of ['P-01-01', 'P-02-01', 'P-02-03', 'P-02-04']) expect(codes).toContain(code);
    // 켜지 않은 축은 여전히 닫혀 있다.
    expect(codes).not.toContain('P-02-08');
    expect(codes).not.toContain('P-02-13');
  });

  it('표가 카탈로그와 같은 17 화면을 덮는다 — 진입 화면 P-CO-01 은 담지 않는다', () => {
    const codes = POP_SCREEN_REQUIREMENTS.map((row) => row.code);

    // SHIP-UNIT-01 이 `P-04-05`(출하 단위 구성)를 더했다: 16 → 17.
    expect(codes).toHaveLength(17);
    expect(new Set(codes).size).toBe(17);
    expect(codes).not.toContain('P-CO-01');
  });
});
