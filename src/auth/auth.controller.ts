import { Body, Controller, Header, HttpCode, Inject, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { IsInt, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import { AuthService } from './auth.service.js';
import { LoginRateGuard } from './login-rate.guard.js';

import { CLIENT_INSTANCE_PATTERN } from './client-instance.js';

export const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/;

class WechatLoginDto {
  @IsString()
  @Length(1, 512)
  @Matches(/^\S+$/)
  code!: string;

  // Omitted means "no new report": the stored version is preserved. An explicit
  // null/empty/invalid value must fail rather than be treated as omission, so
  // ValidateIf is used instead of IsOptional (which also accepts null).
  @ValidateIf((body: WechatLoginDto) => body.clientVersion !== undefined)
  @IsString()
  @Length(1, 64)
  @Matches(CLIENT_VERSION_PATTERN)
  clientVersion?: string;

  // 本地实例标识可省略以兼容旧客户端；显式无效值必须拒绝。
  @ValidateIf((body: WechatLoginDto) => body.clientInstanceId !== undefined)
  @IsString()
  @Length(36, 159)
  @Matches(CLIENT_INSTANCE_PATTERN)
  clientInstanceId?: string;

  // Optional first-registration launch scene. Omitted means "no report"; an explicit
  // null/string/boolean/fraction/zero/negative/overflow must fail instead of being
  // coerced or reaching the column constraint as a storage error.
  @ValidateIf((body: WechatLoginDto) => body.scene !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  scene?: number;
}

@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('wechat-login')
  @UseGuards(LoginRateGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  login(@Body(new ValidationPipe({
    expectedType: WechatLoginDto,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
  })) body: WechatLoginDto) {
    return this.auth.login(body.code, body.clientVersion, body.scene, body.clientInstanceId);
  }
}
