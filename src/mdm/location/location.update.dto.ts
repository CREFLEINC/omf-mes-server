import { OmitType } from '@nestjs/swagger';

import { CreateLocationDto } from './location.create.dto';

/**
 * `PUT` 이라 **전체 교체**다. 안 보낸 선택 필드는 지워진다.
 *
 * `warehouseId` 와 `isActive` 는 받지 않는다. 창고는 등록 후 변경 불가(계약 LocationUpdate
 * 「warehouseId 는 신규만」), `isActive` 는 `:deactivate` 액션으로만 바꾼다.
 * `forbidNonWhitelisted` 가 보내면 400 으로 막는다.
 *
 * `parentLocationId` 는 받는다 — 계층 재배치가 수정의 기능이다. 그래서 **순환 검사가
 * 필요한 것도 수정 쪽**이다(등록은 아직 자식이 없어 순환이 만들어지지 않는다).
 */
export class UpdateLocationDto extends OmitType(CreateLocationDto, ['warehouseId'] as const) {}
