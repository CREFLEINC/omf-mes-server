import { ErrorCode, ErrorItem, fieldError } from '../common/errors/contract-error';
import type { components } from '../contracts/mdm';
import { PrismaService } from '../prisma/prisma.service';
import { countReferences, ReferenceColumn } from './reference-count';

export type Editability = components['schemas']['Editability'];

/**
 * 코드 필드를 지금 고쳐도 되는지에 대한 서버의 판정. 화면이 세지 않는다(공유계약 B-4).
 *
 * 참조가 전부 FK 로 세지는 마스터에만 쓴다 — 지금은 창고·로케이션이다. 나머지 두 사유는
 * 여기서 나오지 않는다: `RECEIVED_FROM_ERP` 는 ERP 수신본(품목·작업자), `NOT_COUNTABLE`
 * 은 FK 가 아니라 코드 문자열로 참조되는 코드값의 것이다. 그때는 이 함수를 쓰지 말고
 * 해당 마스터가 자기 판정을 만든다.
 */
export function toEditability(referenceCount: number): Editability {
  return referenceCount === 0
    ? { codeEditable: true, reason: 'EDITABLE', referenceCount: 0 }
    : { codeEditable: false, reason: 'REFERENCED', referenceCount };
}

/**
 * 상세가 「이 코드는 못 고친다」고 판정한 것을 **쓰기에서도 지킨다.**
 *
 * `toEditability` 가 만드는 것은 화면에 주는 안내일 뿐이고, 계약이 「유효성 판정은
 * 서버가 한다」(공유계약 G-8)고 정한 이상 같은 판정이 저장 경로에도 걸려야 한다.
 * 걸지 않으면 화면이 잠그는 것에만 의존하게 되어, 화면이 여럿이 되는 순간 갈라진다.
 *
 * 코드를 **바꾸려 할 때만** 센다. 이름만 고치는 가장 흔한 수정은 조회가 늘지 않는다.
 */
export async function checkCodeLock(
  prisma: PrismaService,
  references: readonly ReferenceColumn[],
  id: bigint,
  field: string,
  currentCode: string,
  nextCode: string,
): Promise<ErrorItem[]> {
  if (currentCode === nextCode) return [];

  const referenceCount = await countReferences(prisma, references, id);
  if (referenceCount === 0) return [];

  // STATE_LOCKED 인 이유: 새로고침해도 풀리지 않는다. 참조가 사라져야 풀리므로
  // 재로드로 풀리는 저장 충돌(409)과 다르다(공유계약 G-1).
  return [
    fieldError(
      field,
      ErrorCode.STATE_LOCKED,
      `${referenceCount}곳에서 사용 중이라 코드를 바꿀 수 없습니다.`,
    ),
  ];
}
