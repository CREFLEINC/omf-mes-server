import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

import { ContractException, ERROR_CODE } from '../errors';
import { assertUpdated, parseIfMatch, setEtag } from './optimistic-lock';

describe('낙관적 잠금 도구', () => {
  describe('parseIfMatch — 따옴표 형태를 다 받는다', () => {
    it.each([
      ['5', 5],
      ['"5"', 5],
      ['W/"5"', 5],
      [' 7 ', 7],
    ])('%s → %s', (raw, expected) => {
      expect(parseIfMatch(raw)).toBe(expected);
    });

    it.each(['', 'abc', '0', '-1', '1.5', '"5', '5"x'])('%s 는 거절한다', (raw) => {
      expect(parseIfMatch(raw)).toBeNull();
    });

    it('version_no 는 1 부터다 — 0 은 값이 아니다', () => {
      // 물리 모델이 CHECK (version_no > 0) 을 건다.
      expect(parseIfMatch('0')).toBeNull();
      expect(parseIfMatch('1')).toBe(1);
    });
  });

  describe('setEtag', () => {
    it('따옴표 없이 version_no 를 그대로 낸다 — 계약이 「그대로 담는다」라 했다', () => {
      const headers: Record<string, unknown> = {};
      const response = { setHeader: (k: string, v: unknown) => (headers[k] = v) } as unknown as Response;

      setEtag(response, 12);

      expect(headers.ETag).toBe('12');
    });

    it('bigint 도 받는다 — version_no 가 Prisma 에서 그 형태로 올 수 있다', () => {
      const headers: Record<string, unknown> = {};
      const response = { setHeader: (k: string, v: unknown) => (headers[k] = v) } as unknown as Response;

      setEtag(response, 9n);

      expect(headers.ETag).toBe('9');
    });
  });

  describe('assertUpdated', () => {
    it('한 행이라도 고쳤으면 지나간다', () => {
      expect(() => assertUpdated(1)).not.toThrow();
    });

    it('⛔ 0행이면 409 다 — 그 사이 누가 먼저 저장했다', () => {
      let caught: ContractException | undefined;
      try {
        assertUpdated(0);
      } catch (error) {
        caught = error as ContractException;
      }

      expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(caught?.errors[0]).toMatchObject({ scope: 'screen', code: ERROR_CODE.STALE_VERSION });
    });

    it('⛔ STATE_LOCKED 가 아니다 — 재로드하면 풀리는 충돌이라 화면이 달리 말해야 한다', () => {
      let caught: ContractException | undefined;
      try {
        assertUpdated(0);
      } catch (error) {
        caught = error as ContractException;
      }

      expect(caught?.errors[0].code).not.toBe(ERROR_CODE.STATE_LOCKED);
      expect(ERROR_CODE.STALE_VERSION).not.toBe(ERROR_CODE.STATE_LOCKED);
      expect(caught?.errors[0].message).toContain('다시 불러온');
    });
  });
});
