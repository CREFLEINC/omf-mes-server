-- 품목 「수입검사 대상」과 품목 전용 IQC 기준 「기본 생략」을 같은 뜻으로 맞춘다(omf-all-around#215 · 장부 P-155).
-- 이후에는 두 화면의 저장이 서로를 맞춘다 — 여기서는 지금 어긋난 값을 품목 쪽에 맞춰 한 번 정렬한다.
-- 공통 기준(item_id 없음)·PQC·OQC 는 대상이 아니다. pqc_skip_allowed 는 default_skip 과 같은 값을 둔다(#212 호환 칸).
UPDATE quality.inspection_plan p
   SET default_skip = NOT i.inspection_required,
       pqc_skip_allowed = NOT i.inspection_required,
       version_no = p.version_no + 1
  FROM mdm.item i
 WHERE p.item_id = i.item_id
   AND p.inspection_type_code = 'IQC'
   AND p.is_active
   AND p.default_skip = i.inspection_required;
