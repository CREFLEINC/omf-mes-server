import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * 생산실적 등록 입력.
 *
 * 4M(작업자·근무조·설비·금형·단말)은 작업 세션에서 승계하므로 현장은 수량만 보낸다.
 * 재전송 식별자는 본문이 아니라 `Idempotency-Key` 헤더로 받는다(결정서 §160).
 */
export class CreateProductionResultDto {
  @ApiProperty({ description: '양품 수량 — 0보다 커야 한다', example: 300 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  goodQty!: number;

  @ApiPropertyOptional({
    description:
      '실제 생산 시각 — 미지정 시 서버 수신 시각. 오프라인 구간에서 만든 실적은 ' +
      '전송 시각이 아니라 만든 시각을 보내야 집계가 어긋나지 않는다.',
    example: '2026-07-28T09:30:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  occurredAt?: Date;

  @ApiPropertyOptional({ description: '비고' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
