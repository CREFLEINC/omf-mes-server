import { ReferenceColumn } from '../reference-count';

/**
 * `mdm.department.department_id` 를 FK 로 가리키는 모든 곳.
 *
 * `parent_department_id` 가 들어 있다 — 하위 부서를 가진 부서는 코드를 고칠 수 없다.
 *
 * 하나라도 빠지면 **쓰이고 있는 부서가 「수정 가능」으로 잘못 판정된다.**
 * e2e 가 이 목록을 정본 DB 의 `pg_constraint` 와 대조한다.
 */
export const DEPARTMENT_REFERENCES: readonly ReferenceColumn[] = [
  { schema: 'app', table: 'app_user', column: 'department_id' },
  { schema: 'app', table: 'approval_route_step', column: 'approver_department_id' },
  { schema: 'app', table: 'exception_case', column: 'assigned_department_id' },
  { schema: 'mdm', table: 'department', column: 'parent_department_id' },
  { schema: 'mdm', table: 'worker', column: 'department_id' },
  { schema: 'quality', table: 'defect_record', column: 'responsible_department_id' },
  { schema: 'quality', table: 'nonconformance', column: 'responsible_department_id' },
];
