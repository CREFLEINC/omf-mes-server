import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SkipIdempotency } from '../common/idempotency/idempotency.decorators';
import { Public } from './auth.decorators';
import { AuthService } from './auth.service';
import { LoginDto, LoginResponseDto } from './auth.dto';

@ApiTags('인증')
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Public()
  // 계약이 다루지 않는 엔드포인트다. 로그인은 재전송해도 새 토큰을 받으면 그만이다.
  @SkipIdempotency()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '로그인' })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: '사유를 구분하지 않는다 — 계정 열거 방지' })
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.service.login(dto);
  }
}
