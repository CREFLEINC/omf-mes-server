import { ConflictException } from '@nestjs/common';
import { DataSource } from '@prisma/client';

/**
 * ERP 연계 수신본 취급 규칙.
 *
 * 근거: research/2026-07-08-ERP-MES-수신정보-정리.md §4 (QA #34·#35)
 *   - 연계 **원본 필드**는 읽기 전용 — 초기 기획의 "연계분 전체 수정 불가"에서 원본 필드 한정으로 정제됨
 *   - **MES 확장 속성은 편집 가능** (예: 공통코드의 다국어 명칭)
 *   - 삭제는 여전히 불가
 *
 * 즉 레코드 단위가 아니라 **필드 단위**로 잠근다. 마스터마다 확장 속성 목록이 다르므로
 * 각 서비스가 자기 목록을 넘긴다.
 */

/**
 * 공통코드 — 코드그룹의 MES 확장 속성.
 * ERP 원본 필드 = 코드그룹·코드명(ko)·정렬순서·사용여부
 * (WF06 S1의 ERP 측 등록 행위 = "코드그룹+코드값 정의, 코드명·정렬순서·사용여부 등록").
 */
export const CODE_GROUP_MES_FIELDS = ['nameVi', 'description'] as const;

/** 공통코드 — 코드값의 MES 확장 속성. attr1·attr2는 MES 전용 확장 컬럼이다. */
export const CODE_VALUE_MES_FIELDS = ['nameVi', 'description', 'attr1', 'attr2'] as const;

/**
 * 수정 요청이 ERP 원본 필드를 건드리는지 검사한다.
 * MES 정본(source=MES) 레코드는 제약이 없다.
 */
export function assertErpOriginFieldsUntouched(
  source: DataSource,
  patch: Record<string, unknown>,
  editableFields: readonly string[],
  label: string,
): void {
  if (source !== DataSource.ERP) return;

  const locked = Object.keys(patch).filter(
    (key) => patch[key] !== undefined && !editableFields.includes(key),
  );

  if (locked.length > 0) {
    throw new ConflictException(
      `ERP 연계 수신본의 원본 필드는 수정할 수 없습니다: ${label} (${locked.join(', ')}). ` +
        `수정 가능한 MES 확장 속성: ${editableFields.join(', ')}`,
    );
  }
}

/** ERP 연계 수신본은 삭제할 수 없다 — 원본 필드 한정 완화가 삭제에는 적용되지 않는다. */
export function assertDeletable(source: DataSource, label: string): void {
  if (source === DataSource.ERP) {
    throw new ConflictException(`ERP 연계 수신본은 삭제할 수 없습니다: ${label}`);
  }
}
