import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ERROR_CODE } from '../errors';
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

    /**
     * ⭐ 위 상한을 «양쪽에서» 집는다.
     *
     * 거절 쪽만 고정하면 상한이 조용히 «좁아져도» 아무것도 빨개지지 않는다 — 실측으로
     * 확인했다. `!Number.isSafeInteger(skip)` 을 `skip >= 1000` 으로 바꿔도 저장소
     * 단위 검사가 전건 초록이었다. 그 상태는 `size=50` 기준 **22쪽부터 400** 이다.
     *
     * ⚠ 이 자리가 유일한 방어선이다 — 여섯 조회 서비스가 각자 들고 있던 같은 판정을
     * 지웠으므로(`pageRequest` 로 모았다) 여기가 무너지면 그 여섯이 함께 무너진다.
     */
    it('⭐ 안전 정수 안의 쪽은 깊어도 통과한다 — 상한이 좁아지면 여기서 걸린다', () => {
      expect(pageRequest({ page: 100, size: 50 })).toMatchObject({ page: 100, skip: 4_950 });
      expect(pageRequest({ page: 10_000, size: MAX_SIZE })).toMatchObject({ skip: 1_999_800 });
    });

    it('⭐ 상한은 skip 이 안전 정수인가다 — 경계 «바로 아래»는 통과한다', () => {
      const lastSafePage = Math.floor(Number.MAX_SAFE_INTEGER / MAX_SIZE) + 1;
      const request = pageRequest({ page: lastSafePage, size: MAX_SIZE });

      expect(request.skip).toBe((lastSafePage - 1) * MAX_SIZE);
      expect(Number.isSafeInteger(request.skip)).toBe(true);
    });

    it('⭐ 경계 «바로 위»는 400 RANGE 다 — skip 이 부풀면 Prisma 가 500 을 낸다', () => {
      const firstUnsafePage = Math.floor(Number.MAX_SAFE_INTEGER / MAX_SIZE) + 2;

      let thrown: unknown;
      try {
        pageRequest({ page: firstUnsafePage, size: MAX_SIZE });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        status: 400,
        errors: [{ scope: 'field', field: 'page', code: ERROR_CODE.RANGE }],
      });
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
