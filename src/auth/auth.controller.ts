import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ChangePasswordDto, LoginDto } from './auth.dto';
import { CurrentUser, Public } from './auth.decorators';
import { AuthPrincipal, AuthService } from './auth.service';

@ApiTags('인증')
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '로그인 — 액세스 토큰 발급' })
  @ApiResponse({ status: 401, description: '자격증명 불일치 · 잠긴 계정 · 사용 불가 계정' })
  login(@Body() dto: LoginDto) {
    return this.service.login(dto);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: '내 정보 — 유효 기능권한·비밀번호 변경 필요 여부 포함' })
  me(@CurrentUser() user: AuthPrincipal) {
    return {
      loginId: user.loginId,
      userName: user.userName,
      permissions: user.permissions,
      mustChangePassword: user.mustChangePassword,
    };
  }

  @ApiBearerAuth()
  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '내 비밀번호 변경' })
  @ApiResponse({ status: 401, description: '현재 비밀번호 불일치' })
  @ApiResponse({ status: 400, description: '새 비밀번호가 현재와 동일' })
  changePassword(@CurrentUser() user: AuthPrincipal, @Body() dto: ChangePasswordDto) {
    return this.service.changePassword(user.appUserId, dto);
  }
}
