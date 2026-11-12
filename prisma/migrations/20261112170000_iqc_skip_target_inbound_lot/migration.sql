-- IQC 생략 결재의 대상을 입하 LOT 으로(피처 005 S10 · T073 · data-model 「데이터 이전」 4 · omf-all-around#254).
-- 생략은 입하 LOT 단위다(FR-032) — 결재 대상(`target_type_code='INBOUND_LOT'`)의 `target_id` 뜻을 「입하 LOT id」 하나로 맞춘다.
-- 옛 코드도 같은 유형에 «자재 관리 LOT id» 를 넣어 유형으로는 옛·새를 가를 수 없다 — 그래서 열린 것·끝난 것 «전부»를 옮긴다
-- (총괄 결정 2026-11-12). 옮기기 전 LOT id 는 `target_summary.migratedFromLotId` 에 남긴다.
-- ⚠ 생략 요청·실행·결재 대상 이름·단말 읽기 범위가 입하 LOT id 를 읽는 코드와 «함께» 배포한다(같은 PR 의 데이터 단계).

-- 멈춤 조건(배포 전 점검 SQL 과 같은 뜻) — 그 LOT 에 입하 LOT 이 없거나 LOT 이 없으면 옮길 곳이 없다.
DO $$
DECLARE stuck int;
BEGIN
  SELECT count(*) INTO stuck
    FROM app.approval_request a
   WHERE a.approval_type_code = 'IQC_SKIP'
     AND (a.target_type_code <> 'INBOUND_LOT'
          OR NOT EXISTS (SELECT 1 FROM trace.lot l WHERE l.lot_id = a.target_id AND l.inbound_lot_id IS NOT NULL));
  IF stuck > 0 THEN
    RAISE EXCEPTION '입하 LOT 으로 옮길 수 없는 IQC 생략 결재가 %건 있습니다 — 대상 LOT 의 입하 LOT 을 정리한 뒤 배포하세요', stuck;
  END IF;
END $$;

UPDATE app.approval_request a
   SET target_id = l.inbound_lot_id,
       target_summary = COALESCE(a.target_summary, '{}'::jsonb) || jsonb_build_object('migratedFromLotId', a.target_id)
  FROM trace.lot l
 WHERE a.approval_type_code = 'IQC_SKIP'
   AND a.target_type_code = 'INBOUND_LOT'
   AND l.lot_id = a.target_id;
