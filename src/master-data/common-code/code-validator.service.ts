import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * `*_code` 컬럼 값이 해당 공통코드 그룹에 실제로 있는지 검사한다.
 *
 * 정본 DDL은 이 컬럼들을 `app.code_t`(문자열)로만 두고 code_value로 FK를 걸지 않는다.
 * 관리자가 코드를 추가·변경하는 설정형 코드(확정 패턴 **P1**)이기 때문이며,
 * 그래서 값의 유효성은 애플리케이션이 책임진다.
 */
@Injectable()
export class CodeValidatorService {
  constructor(private readonly prisma: PrismaService) {}

  /** 단건 검사. 값이 undefined/null이면 통과시킨다(선택 컬럼). */
  async assertValid(groupCode: string, value: string | undefined | null): Promise<void> {
    if (value === undefined || value === null) return;

    const found = await this.prisma.code_value.findFirst({
      where: {
        code: value,
        is_active: true,
        code_group: { group_code: groupCode, is_active: true },
      },
      select: { code_value_id: true },
    });

    if (!found) {
      const available = await this.prisma.code_value.findMany({
        where: { is_active: true, code_group: { group_code: groupCode } },
        select: { code: true },
        orderBy: { display_order: 'asc' },
        take: 20,
      });
      throw new BadRequestException(
        `${groupCode}에 없는 코드입니다: ${value}` +
          (available.length ? ` (사용 가능: ${available.map((c) => c.code).join(', ')})` : ''),
      );
    }
  }

  /** 여러 코드를 한 번에 검사한다. */
  async assertAllValid(pairs: Array<[group: string, value: string | undefined | null]>): Promise<void> {
    for (const [group, value] of pairs) {
      await this.assertValid(group, value);
    }
  }
}
