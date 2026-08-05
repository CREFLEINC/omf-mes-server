import { ErrorItem } from '../common/errors/contract-error';
import { duplicateWarehouseCode } from './warehouse/warehouse.validator';

/**
 * mdm 마스터의 유니크 위반: **컬럼 목록** → 계약 오류. 마스터가 늘 때마다 한 줄씩 붙는다.
 *
 * `common/` 이 아니라 여기 두는 것은 방향 때문이다 — 공용 계층이 기능 모듈을 참조하면
 * 마스터가 늘수록 기능 모듈 12곳을 import 하는 허브가 된다. 이건 mdm 의 지식이다.
 *
 * 키가 제약 이름(`uq_warehouse`)이 아닌 이유: Prisma 는 `P2002` 의 `meta.target` 에
 * 제약 이름을 담지 않고 컬럼 목록을 담는다. 이 전제는
 * `test/prisma-error-shape.e2e-spec.ts` 가 실제 DB 로 확인한다 — 그 테스트가 이 맵을
 * 직접 조회하므로, 전제가 바뀌거나 키를 잘못 적으면 깨진다.
 */
export const UNIQUE_VIOLATIONS = new Map<string, () => ErrorItem>([
  ['plant_id,warehouse_code', duplicateWarehouseCode],
]);
