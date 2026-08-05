import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  readonly loginId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  // 상한이 없으면 수 MB 짜리 문자열로 scrypt 를 돌리게 만들 수 있다.
  @MaxLength(200)
  readonly password!: string;
}

export class LoginResponseDto {
  @ApiProperty()
  readonly accessToken!: string;

  @ApiProperty({ description: '토큰 유효 시간(초)' })
  readonly expiresIn!: number;

  @ApiProperty({ description: '참이면 화면이 비밀번호 변경을 강제해야 한다' })
  readonly mustChangePassword!: boolean;
}
