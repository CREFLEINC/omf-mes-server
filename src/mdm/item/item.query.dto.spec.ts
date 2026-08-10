import { plainToInstance } from 'class-transformer';

import { ItemQueryDto } from './item.query.dto';

const parse = (query: Record<string, unknown>) => plainToInstance(ItemQueryDto, query);

describe('ItemQueryDto.hasRouting', () => {
  it('안 보내면 undefined 다 — false 로 접히면 Routing 없는 품목만 나온다', () => {
    // includeInactive 와 달리 기본값이 없다. 「안 거른다」와 「없는 것만」이 다른 뜻이다.
    expect(parse({}).hasRouting).toBeUndefined();
  });

  it("'false' 를 참으로 읽지 않는다 — Boolean('false') 는 true 다", () => {
    expect(parse({ hasRouting: 'false' }).hasRouting).toBe(false);
  });

  it("'true' 는 참이다", () => {
    expect(parse({ hasRouting: 'true' }).hasRouting).toBe(true);
  });
});
