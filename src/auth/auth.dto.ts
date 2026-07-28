import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** 비밀번호 최소 길이. 짧은 값이 초기 비밀번호로 굳는 것을 막는다. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export class LoginDto {
  @ApiProperty({ description: '로그인 ID', example: 'admin' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  loginId!: string;

  @ApiProperty({ description: '비밀번호' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: '현재 비밀번호' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({ description: `새 비밀번호 — 최소 ${PASSWORD_MIN_LENGTH}자` })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

/** 관리자가 타인의 비밀번호를 재발급할 때. 다음 로그인에서 변경을 강제한다. */
export class SetPasswordDto {
  @ApiProperty({ description: `발급할 비밀번호 — 최소 ${PASSWORD_MIN_LENGTH}자` })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
