import { ContractException } from '../../common/errors';
import { assertProcesses } from './terminal.service';

function errorsOf(run: () => void): unknown[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractException) return (error.getResponse() as { errors: unknown[] }).errors;
    throw error;
  }
  return [];
}

describe('assertProcesses — 단말 공정 매핑 줄 검증', () => {
  it('기능을 하나도 켜지 않은 줄은 그 줄을 짚어 INVALID 다', () => {
    const errors = errorsOf(() => assertProcesses([{ processId: 1, canStartWork: true }, { processId: 2 }, { processId: 3, canPrintLabel: false }]));

    expect(errors).toEqual([
      expect.objectContaining({ scope: 'field', field: 'items[1]', code: 'INVALID' }),
      expect.objectContaining({ scope: 'field', field: 'items[2]', code: 'INVALID' }),
    ]);
  });

  it('기능이 하나라도 켜져 있으면 통과한다', () => {
    expect(errorsOf(() => assertProcesses([{ processId: 1, canReturnMaterial: true }]))).toEqual([]);
  });

  it('같은 공정 중복은 그대로 UNIQUE_VIOLATION 이고, 빈 줄 오류와 함께 낸다', () => {
    const errors = errorsOf(() => assertProcesses([{ processId: 1, canStartWork: true }, { processId: 1 }]));

    expect(errors).toEqual([
      expect.objectContaining({ field: 'items[1]', code: 'INVALID' }),
      expect.objectContaining({ field: 'items[1].processId', code: 'UNIQUE_VIOLATION' }),
    ]);
  });
});
