import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ReplaceUomConversionsDto } from './item-child.dto';

async function errorsFor(effectiveFrom: unknown): Promise<string[]> {
  const dto = plainToInstance(ReplaceUomConversionsDto, {
    conversions: [{ fromUomId: 1, toUomId: 2, conversionRate: 12, effectiveFrom }],
  });
  const errors = await validate(dto);

  return errors.flatMap((error) =>
    (error.children ?? []).flatMap((row) => (row.children ?? []).map((field) => field.property)),
  );
}

describe('부속 행의 날짜', () => {
  it('YYYY-MM-DD 는 통과한다', async () => {
    expect(await errorsFor('2026-08-07')).toEqual([]);
  });

  it.each([
    ['시각이 붙으면', '2026-08-07T00:00:00Z'],
    ['없는 날이면', '2026-02-30'],
    ['달이 범위를 넘으면', '2026-13-01'],
    ['자릿수가 다르면', '2026-8-7'],
    ['문자열이 아니면', 20260807],
  ])('%s 걸린다', async (_label, value) => {
    // IsDateString 은 앞 둘을 통과시킨다 — 시각은 타임존을 태워 하루를 밀고,
    // 없는 날은 DB 까지 가서 500 이 된다.
    expect(await errorsFor(value)).toEqual(['effectiveFrom']);
  });
});
