import { assertCodeKept } from './warehouse.service';

describe('assertCodeKept — 창고 코드는 만든 뒤 바꾸지 않는다(omf-all-around#292)', () => {
  it('⭐ 같은 값은 통과한다', () => {
    expect(() => assertCodeKept('S230', 'S230')).not.toThrow();
  });

  it('⛔ 다른 값이면 400 warehouseCode STATE_LOCKED', () => {
    try {
      assertCodeKept('S230', 'S231');
      throw new Error('막지 않았다');
    } catch (error) {
      const response = (error as { getStatus(): number; getResponse(): { errors: unknown[] } });
      expect(response.getStatus()).toBe(400);
      expect(response.getResponse().errors).toEqual([
        expect.objectContaining({ scope: 'field', field: 'warehouseCode', code: 'STATE_LOCKED' }),
      ]);
    }
  });
});
