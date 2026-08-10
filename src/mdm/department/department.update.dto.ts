import { CreateDepartmentDto } from './department.create.dto';

/**
 * `PUT` 이라 **전체 교체**다. 안 보낸 선택 필드는 지워진다.
 *
 * 등록과 받는 필드가 같다 — 창고의 `plantId`, 로케이션의 `warehouseId` 처럼 「신규만」인
 * 필드가 부서에는 없다. 사업부는 바꿀 수 있다(조직 개편이 그것이다).
 *
 * `isActive` 는 받지 않는다 — `:deactivate` 액션 전용이고 `forbidNonWhitelisted` 가 막는다.
 */
export class UpdateDepartmentDto extends CreateDepartmentDto {}
