import { plainToInstance } from 'class-transformer';
import { IsOptional, validate } from 'class-validator';

import { IsDateOnly } from './date-only.validator';

class Probe {
  @IsDateOnly()
  readonly on!: string;

  @IsOptional()
  @IsDateOnly()
  readonly until?: string | null;
}

async function invalidFields(value: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(Probe, { on: value }));

  return errors.map((error) => error.property);
}

describe('IsDateOnly', () => {
  it('YYYY-MM-DD 는 통과한다', async () => {
    expect(await invalidFields('2026-08-07')).toEqual([]);
  });

  it.each([
    ['시각이 붙으면', '2026-08-07T00:00:00Z'],
    ['없는 날이면', '2026-02-30'],
    ['달이 범위를 넘으면', '2026-13-01'],
    ['자릿수가 다르면', '2026-8-7'],
    ['문자열이 아니면', 20260807],
    ['빈 문자열이면', ''],
  ])('%s 걸린다', async (_label, value) => {
    // IsDateString 은 앞 둘을 통과시킨다 — 시각은 타임존을 태워 하루를 밀고,
    // 없는 날은 DB 까지 가서 500 이 된다.
    expect(await invalidFields(value)).toEqual(['on']);
  });

  it('선택 필드는 안 보내면 안 걸린다', async () => {
    const errors = await validate(plainToInstance(Probe, { on: '2026-08-07' }));

    expect(errors).toEqual([]);
  });
});
