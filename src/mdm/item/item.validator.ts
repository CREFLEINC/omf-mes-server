import { Injectable } from '@nestjs/common';

import { ErrorCode, ErrorItem, fieldError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateItemDto } from './item.update.dto';

/** 코드 필드가 어느 공통코드 그룹에 속해야 하는지. 값 목록은 `mdm.code_value` 가 정본이다. */
const CODE_GROUPS = {
  lotControlTypeCode: 'LOT_CONTROL_TYPE',
  serialControlTypeCode: 'SERIAL_CONTROL_TYPE',
  fifoPolicyCode: 'FIFO_POLICY',
  storageConditionCode: 'STORAGE_CONDITION',
} as const;

@Injectable()
export class ItemValidator {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 원본 4열은 검사하지 않는다 — DTO 가 받지 않으므로 여기 올 수 없다.
   * 유일성 검사도 없다: `item_code` 는 바뀌지 않는다.
   */
  async validateUpdate(dto: UpdateItemDto): Promise<ErrorItem[]> {
    const pairs = Object.entries(CODE_GROUPS) as [keyof typeof CODE_GROUPS, string][];

    const results = await Promise.all(
      pairs.map(async ([field, groupCode]) => {
        const value = dto[field];
        // 선택 코드는 안 보내면 검사할 것이 없다. 필수 코드는 DTO 가 막는다.
        if (value === undefined || value === null) return null;

        const found = await this.prisma.code_value.findFirst({
          where: { code: value, code_group: { group_code: groupCode }, is_active: true },
          select: { code_value_id: true },
        });

        return found ? null : fieldError(field, ErrorCode.RANGE, `${groupCode} 에 없는 코드입니다.`);
      }),
    );

    return results.filter((error): error is ErrorItem => error !== null);
  }
}
