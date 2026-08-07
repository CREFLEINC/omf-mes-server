-- mdm.department 를 가리키는 외래키 컬럼에 인덱스를 단다.
--
-- ⚠ 이 인덱스들은 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 왜 필요한가:
--   PostgreSQL은 외래키 컬럼에 인덱스를 자동으로 만들지 않는다. mdm.department 를
--   가리키는 7개 컬럼에 쓸 수 있는 인덱스가 **하나도 없다**.
--
--   두 곳에서 돈다:
--     · 부서 상세의 참조 건수 — 편집 잠금 판정이라 화면을 열 때마다(공유계약 B-4)
--     · 부서 계층의 순환 검사 — parent_department_id 를 타고 올라가는 재귀 CTE
--
--   뒤쪽이 특히 중요하다. 로케이션은 ix_location_parent 가 이미 있어 L2 에서 인덱스를
--   더할 일이 없었는데, 부서는 자기참조 컬럼조차 비어 있다. 인덱스 없이 재귀 CTE 를
--   돌리면 한 단계 올라갈 때마다 전체를 훑는다.
--
-- 「인덱스가 있다」 판정:
--   pg_constraint 와 pg_index 를 대조한다 — indkey[0] = 컬럼(선행) AND indpred IS NULL
--   (부분 아님). 눈으로 세다 두 번 틀린 뒤로 판정을 테스트에 넘겼고,
--   test/mdm-department.e2e-spec.ts 가 매번 돌린다.
--
-- 되돌리기:
--   DROP INDEX 로 걷어낸다. 인덱스는 스키마 변경 중 가장 되돌리기 쉬운 축이다.

CREATE INDEX ix_department_parent
  ON mdm.department (parent_department_id);

CREATE INDEX ix_app_user_department
  ON app.app_user (department_id);

CREATE INDEX ix_approval_route_step_approver_department
  ON app.approval_route_step (approver_department_id);

CREATE INDEX ix_exception_case_assigned_department
  ON app.exception_case (assigned_department_id);

CREATE INDEX ix_worker_department
  ON mdm.worker (department_id);

CREATE INDEX ix_defect_record_responsible_department
  ON quality.defect_record (responsible_department_id);

CREATE INDEX ix_nonconformance_responsible_department
  ON quality.nonconformance (responsible_department_id);
