import { ContractException } from '../common/errors';
import { wrongTerminalType } from './terminal-type-denied';

const messageOf = (error: ContractException) => error.errors[0].message;

describe('wrongTerminalType — 맞지 않는 단말 유형의 401 은 원인과 맞는 화면을 알린다', () => {
  it('PDA 전용 경로를 POP 으로 부르면 PDA 화면 이름과 코드를 짚는다 — 상태는 401 그대로', () => {
    const error = wrongTerminalType('PUT /inventory/handling-units/{handlingUnitId}/contents', ['MOBILE'], 'POP');

    expect(error.getStatus()).toBe(401);
    expect(messageOf(error)).toBe('이 기능은 PDA(모바일 단말)에서만 쓸 수 있습니다(지금 단말: POP 단말) — PDA(모바일 단말) 포장 재구성 스캔(M-04-03)에서 하세요.');
  });

  it('POP 전용 경로를 PDA 로 부르면 POP 화면을 짚는다', () => {
    expect(messageOf(wrongTerminalType('POST /production/work-sessions', ['POP'], 'MOBILE')))
      .toMatch(/^이 기능은 POP 단말에서만 쓸 수 있습니다\(지금 단말: PDA\(모바일 단말\)\) — POP 단말 .+\(P-\d{2}-\d{2}\)에서 하세요\.$/);
  });

  it('US2-8 — 닫은 공정 인계 등록은 없어진 PDA 화면(M-02-01) 대신 POP 자재 투입을 안내한다(피처 016) — 상태는 401 그대로', () => {
    const error = wrongTerminalType('POST /production/operation-handovers', ['MOBILE'], 'POP');

    expect(error.getStatus()).toBe(401);
    expect(messageOf(error)).toBe('공정 인계는 반제품 투입으로 바뀌었습니다 — POP 단말 자재 투입 스캔·오투입 검증(P-02-03)에서 반제품 LOT 을 스캔해 투입하세요.');
    expect(messageOf(error)).not.toContain('M-02-01');
  });

  it('맞는 단말의 화면을 권한 표에서 못 찾으면 단말 유형만 알린다', () => {
    expect(messageOf(wrongTerminalType('GET /nowhere', ['MOBILE'], 'POP')))
      .toBe('이 기능은 PDA(모바일 단말)에서만 쓸 수 있습니다(지금 단말: POP 단말) — PDA(모바일 단말)에서 하세요.');
  });
});
