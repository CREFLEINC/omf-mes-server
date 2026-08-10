import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/** `IsNotEmpty` 는 '   ' 를 통과시킨다. 계약이 「공백만 불가」로 명시했으므로 먼저 다듬는다. */
const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateDepartmentDto {
  @ApiProperty({ description: '전역 유일 — department_code_key. 공백만 불가' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  readonly departmentCode!: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly departmentName!: string;

  @ApiPropertyOptional({ description: '상위 부서. 자기 자신·순환 금지' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly parentDepartmentId?: number | null;

  @ApiPropertyOptional({ description: '선택 — 부서는 사업부에 속하지 않을 수 있다' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  readonly businessUnitId?: number | null;
}
