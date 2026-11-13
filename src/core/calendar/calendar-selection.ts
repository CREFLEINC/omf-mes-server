import { Prisma } from '@prisma/client';

/**
 * 날짜마다 따를 작업 캘린더 하나를 고르는 SQL — 설비 가동 정지 요약과 생산계획 근무일 판정이 이 한 벌을 쓴다.
 * 라인 → 상위 라인(가까운 순) → 공장 순으로 적용이 있는 첫 층, 적용 기간이 그 날짜를 덮는 것만, 같은 층이면 적용 시작일이 늦은 것.
 * ⛔ 캘린더 사용 여부·그 날짜의 등록 여부는 고르는 데 쓰지 않는다 — 고른 캘린더에 날짜가 없어도 다음 층으로 내려가지 않는다.
 *
 * 쓰는 쪽 질의는 `scope` 별칭에 `<key>`·`plant_id`·`calendar_date` 칸을 두고, `lineAncestors` 의 원천 표에 `<key>`·`line_id` 칸을 둔다.
 * `key`·`source` 는 코드의 상수만 넘긴다(식별자라 바인딩하지 못한다).
 */

/** `line_ancestors(<key>, line_id, depth, path)` — 라인과 그 상위 라인 전부. 순환은 path 로 끊는다. */
export function lineAncestors(source: string, key: string): Prisma.Sql {
  const k = Prisma.raw(key);
  return Prisma.sql`line_ancestors(${k},line_id,depth,path) AS (
        SELECT ${k},line_id,0,ARRAY[line_id]
        FROM ${Prisma.raw(source)} WHERE line_id IS NOT NULL
        UNION ALL
        SELECT a.${k},line.parent_line_id,a.depth+1,
          a.path||line.parent_line_id
        FROM line_ancestors a
        JOIN mdm.production_line line ON line.production_line_id=a.line_id
        WHERE line.parent_line_id IS NOT NULL
          AND NOT line.parent_line_id=ANY(a.path)
      )`;
}

/** `selected(work_calendar_id, line_depth, applied_line_id)` — 공장 층에서 골랐으면 line_depth 가 null 이다. */
export function selectedCalendar(key: string): Prisma.Sql {
  const k = Prisma.raw(key);
  return Prisma.sql`LEFT JOIN LATERAL (
        SELECT candidate.work_calendar_id,
          CASE WHEN candidate.scope_rank=0 THEN candidate.depth END line_depth,
          CASE WHEN candidate.scope_rank=0 THEN candidate.target_id END applied_line_id
        FROM (
          SELECT application.*,0 scope_rank,ancestor.depth
          FROM mdm.work_calendar_application application
          JOIN line_ancestors ancestor
            ON ancestor.${k}=scope.${k}
            AND ancestor.line_id=application.target_id
          WHERE application.target_type_code='EQUIPMENT_GROUP'
          UNION ALL
          SELECT application.*,1 scope_rank,0 depth
          FROM mdm.work_calendar_application application
          WHERE application.target_type_code='PLANT'
            AND application.target_id=scope.plant_id
        ) candidate
        WHERE candidate.effective_from<=scope.calendar_date
          AND (candidate.effective_to IS NULL OR
            candidate.effective_to>=scope.calendar_date)
        ORDER BY candidate.scope_rank,candidate.depth,
          candidate.effective_from DESC,
          candidate.work_calendar_application_id DESC LIMIT 1
      ) selected ON TRUE`;
}
