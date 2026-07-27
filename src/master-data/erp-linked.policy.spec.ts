import { ConflictException } from '@nestjs/common';
import { DataSource } from '@prisma/client';

import {
  assertDeletable,
  assertErpOriginFieldsUntouched,
  CODE_VALUE_MES_FIELDS,
} from './erp-linked.policy';

const check = (source: DataSource, patch: Record<string, unknown>) =>
  assertErpOriginFieldsUntouched(source, patch, CODE_VALUE_MES_FIELDS, 'ITEM_TYPE.RAW');

describe('ERP 연계 수신본 취급 규칙', () => {
  describe('MES 정본(source=MES)', () => {
    it('어떤 필드든 제약 없이 수정할 수 있다', () => {
      expect(() => check(DataSource.MES, { nameKo: 'x', sortOrder: 1, useYn: false })).not.toThrow();
    });

    it('삭제할 수 있다', () => {
      expect(() => assertDeletable(DataSource.MES, 'ITEM_TYPE.RAW')).not.toThrow();
    });
  });

  describe('ERP 연계 수신본(source=ERP)', () => {
    it('MES 확장 속성만 보내면 통과한다', () => {
      expect(() =>
        check(DataSource.ERP, { nameVi: 'Nguyên vật liệu', description: '설명', attr1: 'a' }),
      ).not.toThrow();
    });

    it('원본 필드를 건드리면 거부한다', () => {
      expect(() => check(DataSource.ERP, { nameKo: '자재' })).toThrow(ConflictException);
      expect(() => check(DataSource.ERP, { sortOrder: 1 })).toThrow(ConflictException);
      expect(() => check(DataSource.ERP, { useYn: false })).toThrow(ConflictException);
    });

    it('거부 메시지에 문제가 된 필드명을 담는다', () => {
      expect(() => check(DataSource.ERP, { nameKo: 'x', sortOrder: 1 })).toThrow(
        /nameKo, sortOrder/,
      );
    });

    it('undefined 필드는 무변경이므로 검사 대상이 아니다', () => {
      // PATCH 페이로드에 없던 키가 DTO 인스턴스에 undefined로 남아도 거부하면 안 된다.
      expect(() => check(DataSource.ERP, { nameVi: 'ok', nameKo: undefined })).not.toThrow();
    });

    it('빈 수정 요청은 통과한다', () => {
      expect(() => check(DataSource.ERP, {})).not.toThrow();
    });

    it('삭제는 여전히 불가하다', () => {
      expect(() => assertDeletable(DataSource.ERP, 'ITEM_TYPE.RAW')).toThrow(ConflictException);
    });
  });
});
