import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { BasePageQueryDto } from '../common/dto/page-query.dto';

/**
 * 작업지시는 is_active가 없고 상태코드로 수명주기를 관리한다 — PageQueryDto가 아니라
 * BasePageQueryDto를 확장한다(page-query.dto.ts 주 참조).
 */
export class PopWorkOrderQueryDto extends BasePageQueryDto {
  @ApiPropertyOptional({
    description: '공정코드 — 단말이 여러 공정을 담당할 때 하나로 좁혀 조회한다',
    example: 'INJECTION',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  processCode?: string;
}

/**
 * 「작업 시작」 입력. **4M은 기본적으로 작업지시의 계획값을 승계한다** — 아래 값은
 * 계획과 다르게 투입할 때만 보낸다. 실물 스캔으로 대조하는 오투입 검증은 다음 단계다.
 */
export class StartWorkDto {
  @ApiPropertyOptional({
    description: '근무조 코드 — 미지정 시 작업지시의 계획 근무조. 둘 다 없으면 400',
    example: 'DAY',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  shiftCode?: string;

  @ApiPropertyOptional({ description: '설비 코드 — 미지정 시 계획 설비', example: 'INJ-01' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  equipmentCode?: string;

  @ApiPropertyOptional({ description: '금형 코드 — 미지정 시 계획 금형', example: 'MOLD-A17' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  moldCode?: string;

  @ApiPropertyOptional({ description: '비고' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
