import { Body, Controller, Header, HttpCode, Inject, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { AuthService } from './auth.service.js';
import { LoginRateGuard } from './login-rate.guard.js';

class WechatLoginDto {
  @IsString()
  @Length(1, 512)
  @Matches(/^\S+$/)
  code!: string;
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
    return this.auth.login(body.code);
  }
}
