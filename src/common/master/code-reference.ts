import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../errors';

/** 검사할 칸 하나 — 계약 필드 이름, 그 값, 값이 속해야 할 코드 그룹. */
export interface CodeCheck {
  field: string;
  value: string | null | undefined;
  groupCode: string;
}

/**
 * 「공통코드」라고 적힌 칸이 실제로 그 그룹의 «쓰는» 값인지 본다.
 *
 * 계약 검증 가드는 글자 길이와 형식까지만 본다 — 계약이 값 목록을 `enum` 으로 적지 않고
 * 「`GET /mdm/code-values?codeGroupCode=...` 로 받는다」로 적었기 때문이다(G-32).
 * 그래서 아무 문자열이나 통과한다. 마스터에 없는 코드가 들어가면 화면이 그 행을 그릴 때
 * 이름을 찾지 못해 코드 글자가 그대로 노출된다.
 *
 * ⛔ 비활성 값도 막는다. 사용 중지한 코드로 «새» 마스터를 세우면 중지의 뜻이 없어진다.
 * 이미 그 값을 쓰던 기존 행은 건드리지 않는다 — 물리 삭제를 두지 않는 이유와 같다.
 */
export async function assertCodeValues(
  prisma: Pick<Prisma.TransactionClient, 'code_value'>,
  checks: readonly CodeCheck[],
): Promise<void> {
  const present = checks.filter(
    (c): c is CodeCheck & { value: string } => typeof c.value === 'string',
  );
  if (present.length === 0) return;

  const found = await prisma.code_value.findMany({
    where: {
      is_active: true,
      OR: present.map((c) => ({ code: c.value, code_group: { group_code: c.groupCode } })),
    },
    select: { code: true, code_group: { select: { group_code: true } } },
  });
  const known = new Set(found.map((row) => `${row.code_group.group_code} ${row.code}`));

  const errors: ErrorItem[] = present
    .filter((c) => !known.has(`${c.groupCode} ${c.value}`))
    .map((c) => ({
      scope: 'field' as const,
      field: c.field,
      code: ERROR_CODE.INVALID,
      message: `${c.groupCode} 에 없거나 사용 중지된 코드입니다.`,
    }));

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
