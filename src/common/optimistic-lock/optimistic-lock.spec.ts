import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

import { ConflictException } from '../errors';
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
      let caught: ConflictException | undefined;
      try {
        assertUpdated(0);
      } catch (error) {
        caught = error as ConflictException;
      }

      expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT);
      // ⛔ 봉투가 `ErrorResponse` 가 아니다 — 계약 `ConflictResponse` 다.
      expect(caught?.conflict).toEqual({
        conflictCause: 'user',
        message: expect.stringContaining('다시 불러온'),
      });
    });

    it('⭐ 원인을 호출자가 고른다 — 화면 문구가 그것으로 갈린다', () => {
      let caught: ConflictException | undefined;
      try {
        assertUpdated(0, 'erpSync');
      } catch (error) {
        caught = error as ConflictException;
      }

      expect(caught?.conflict.conflictCause).toBe('erpSync');
      expect(caught?.conflict.message).toContain('기간계');
    });

    it('⛔ 응답 본문에 errors 배열이 없다 — 화면이 conflictCause 를 찾아야 한다', () => {
      let caught: ConflictException | undefined;
      try {
        assertUpdated(0);
      } catch (error) {
        caught = error as ConflictException;
      }

      expect(caught?.getResponse()).not.toHaveProperty('errors');
      expect(caught?.getResponse()).toHaveProperty('conflictCause');
    });
  });
});
