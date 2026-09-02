import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_PAGE, DEFAULT_SIZE, MAX_SIZE, pageRequest, pagedResponse } from './pagination';

describe('페이징', () => {
  describe('pageRequest', () => {
    it('없으면 계약이 선언한 기본값이다 — page=1 · size=50', () => {
      expect(pageRequest()).toEqual({ page: 1, size: 50, skip: 0, take: 50 });
      expect(DEFAULT_PAGE).toBe(1);
      expect(DEFAULT_SIZE).toBe(50);
    });

    it('skip 을 쪽에서 만든다', () => {
      expect(pageRequest({ page: 3, size: 20 })).toMatchObject({ skip: 40, take: 20 });
    });

    it('⛔ size 상한을 건다 — 상한 없는 목록 질의는 한 번으로 서버를 재운다', () => {
      expect(pageRequest({ size: 1_000_000 }).size).toBe(MAX_SIZE);
      expect(MAX_SIZE).toBe(200);
    });

    it('0쪽·음수쪽은 첫 쪽으로 자른다 — 목록에서 뜻이 없다', () => {
      expect(pageRequest({ page: 0 }).page).toBe(1);
      expect(pageRequest({ page: -5 }).page).toBe(1);
    });

    it('size 0·음수는 1 이상으로 자른다', () => {
      expect(pageRequest({ size: 0 }).size).toBe(DEFAULT_SIZE);
      expect(pageRequest({ size: -3 }).size).toBe(1);
    });

    it('소수는 버린다 — 계약이 integer 로 선언했다', () => {
      expect(pageRequest({ page: 2.9, size: 10.7 })).toMatchObject({ page: 2, size: 10 });
    });
  });

  describe('pagedResponse', () => {
    it('⭐ 계약 PageMeta 스키마를 만족한다', () => {
      const contract = JSON.parse(
        readFileSync(join(__dirname, '../../../contracts/app-공통.json'), 'utf8'),
      ) as { components: Record<string, unknown> };
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      addFormats(ajv);
      ajv.addSchema({ $id: 'contract', components: contract.components });
      const validate = ajv.compile({ $ref: 'contract#/components/schemas/PageMeta' });

      const response = pagedResponse([{ id: 1 }], 137, pageRequest({ page: 2, size: 50 }));

      expect(validate(response.page)).toBe(true);
      expect(response.page).toEqual({ page: 2, size: 50, total: 137 });
      // 헛통과가 아님을 보인다.
      expect(validate({ page: 1 })).toBe(false);
    });

    it('items 를 그대로 싣는다', () => {
      expect(pagedResponse([1, 2, 3], 3, pageRequest()).items).toEqual([1, 2, 3]);
    });
  });
});
