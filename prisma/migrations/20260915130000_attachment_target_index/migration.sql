-- 첨부 목록(GET /app/attachments)이 다형 쌍으로 거르고 uploaded_at desc 로 정렬한다.
-- 형제 표 ix_document_issue_target 과 같은 모양이다. 설계 문의 156 「되돌릴 때」의 인덱스(#652).
-- 추가만 하므로 블루-그린 전환 중 옛 코드와 함께 돌아도 안전하다.
CREATE INDEX ix_attachment_target
  ON app.attachment(target_type_code, target_id, uploaded_at DESC);
