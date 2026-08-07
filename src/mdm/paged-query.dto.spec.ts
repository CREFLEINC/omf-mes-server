import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PagedQueryDto } from './paged-query.dto';

async function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(PagedQueryDto, query, { enableImplicitConversion: false });
  const errors = await validate(dto);

  return { dto, errors };
}

describe('PagedQueryDto', () => {
  it('안 보내면 기본값이 붙는다', async () => {
    const { dto, errors } = await parse({});

    expect(errors).toHaveLength(0);
    expect({ page: dto.page, size: dto.size, includeInactive: dto.includeInactive }).toEqual({
      page: 1,
      size: 50,
      includeInactive: false,
    });
  });

  it("includeInactive=false 를 참으로 읽지 않는다 — Boolean('false') 는 true 다", async () => {
    const { dto } = await parse({ includeInactive: 'false' });

    expect(dto.includeInactive).toBe(false);
  });

  it('size 상한을 넘기면 걸린다 — 없으면 전 테이블을 긁어간다', async () => {
    const { errors } = await parse({ size: '1000000' });

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('size');
  });

  it('skip 은 페이지에서 계산된다', async () => {
    const { dto } = await parse({ page: '3', size: '20' });

    expect(dto.skip).toBe(40);
  });
});
