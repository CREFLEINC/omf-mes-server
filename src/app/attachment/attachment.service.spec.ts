import { ATTACHMENT_ORDER_BY, buildAttachmentWhere } from './attachment.service';

describe('첨부 목록 — where·정렬 빌더(I-34 PR ①)', () => {
  it('둘 다 주면 두 칸을 함께 건다', () => {
    expect(buildAttachmentWhere({ targetTypeCode: 'WAREHOUSE', targetId: 1001 })).toEqual({
      target_type_code: 'WAREHOUSE',
      target_id: 1001,
    });
  });

  it('유형만 주면 유형 하나만 건다 — 400 이 아니다(§0 자리 1)', () => {
    expect(buildAttachmentWhere({ targetTypeCode: 'WAREHOUSE' })).toEqual({
      target_type_code: 'WAREHOUSE',
    });
  });

  it('id 만 주면 id 하나만 건다 — 400 이 아니다(§0 자리 1)', () => {
    expect(buildAttachmentWhere({ targetId: 1001 })).toEqual({ target_id: 1001 });
  });

  // ⛔ 둘 다 없으면 조건을 지어내지 않는다 — `{}` 그대로가 전건 조회를 낳는다(§0 자리 2).
  it('둘 다 없으면 `{}` 다', () => {
    expect(buildAttachmentWhere({})).toEqual({});
  });

  it('정렬은 `uploaded_at desc` + PK `attachment_id desc` 2키다', () => {
    expect(ATTACHMENT_ORDER_BY).toEqual([{ uploaded_at: 'desc' }, { attachment_id: 'desc' }]);
  });
});
