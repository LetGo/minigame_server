import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppConfig, CONFIG } from './config.js';
import { Infrastructure } from './infrastructure.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { WechatClient } from './auth/wechat.client.js';
import { LoginRateGuard } from './auth/login-rate.guard.js';
import { DataController } from './data/data.controller.js';
import { DataService } from './data/data.service.js';
import { InvitesService } from './invites/invites.service.js';
import { InvitesController } from './invites/invites.controller.js';
import { ProfileController } from './users/profile.controller.js';
import { RewardedVideoController } from './analytics/rewarded-video.controller.js';
import { RewardedVideoService } from './analytics/rewarded-video.service.js';
import {SubscriptionsController} from './subscriptions/subscriptions.controller.js';
import {SubscriptionsService} from './subscriptions/subscriptions.service.js';

@Catch()
class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const parserErrors: Record<string, { status: number; message: string }> = {
      'entity.parse.failed': { status: 400, message: 'INVALID_JSON' },
      'entity.too.large': { status: 413, message: 'REQUEST_TOO_LARGE' },
      'encoding.unsupported': { status: 415, message: 'UNSUPPORTED_ENCODING' },
      'charset.unsupported': { status: 415, message: 'UNSUPPORTED_CHARSET' },
    };
    const parserType = error instanceof Error && 'type' in error && typeof error.type === 'string' ? error.type : '';
    const parserError = Object.hasOwn(parserErrors, parserType) ? parserErrors[parserType] : undefined;
    const status = error instanceof HttpException ? error.getStatus() : parserError?.status ?? 500;
    const body = error instanceof HttpException ? error.getResponse() : { statusCode: status, message: parserError?.message ?? 'INTERNAL_SERVER_ERROR' };
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}

@Module({})
class AppModule {}

export async function createApplication(config: AppConfig, overrides: { wechat?: WechatClient } = {}) {
  const infrastructure = new Infrastructure(config);
  await infrastructure.connect();
  try {
    const app = await NestFactory.create<NestExpressApplication>({
      module: AppModule,
      controllers: [AuthController, DataController, InvitesController, ProfileController, RewardedVideoController, ...(config.subscribeMessagesEnabled ? [SubscriptionsController] : [])],
      providers: [
        { provide: Infrastructure, useValue: infrastructure },
        { provide: CONFIG, useValue: config },
        LoginRateGuard,
        ...(config.subscribeMessagesEnabled ? [{provide: SubscriptionsService, useValue: new SubscriptionsService(config, infrastructure)}] : []),
        { provide: DataService, useValue: new DataService(config, infrastructure) },
        { provide: RewardedVideoService, useValue: new RewardedVideoService(config, infrastructure) },
        { provide: InvitesService, useValue: new InvitesService(config, infrastructure) },
        { provide: AuthService, useValue: new AuthService(config, infrastructure, overrides.wechat ?? new WechatClient(config)) },
      ],
    }, { bodyParser: false, logger: ['error', 'warn'], abortOnError: false });
    app.setGlobalPrefix('h5login');
    app.set('trust proxy', config.trustLocalProxy ? 'loopback' : false);
    app.use(helmet());
    const loginJson = json({ limit: '16kb', strict: true, inflate: false });
    const dataJson = json({ limit: '256kb', strict: true, inflate: false });
    app.use((request: Request, response: Response, next: NextFunction) => {
      const parser = ['/h5login/api/data/save', '/h5login/api/data/get'].includes(request.path) ? dataJson : loginJson;
      parser(request, response, next);
    });
    app.use((error: unknown, _request: Request, _response: Response, next: NextFunction) => {
      // Normalize before Nest maps SyntaxError and loses the parser's safe error type.
      if (error instanceof Error && 'type' in error && error.type === 'entity.parse.failed') {
        next(new HttpException('INVALID_JSON', 400));
        return;
      }
      next(error);
    });
    app.useGlobalFilters(new SafeExceptionFilter());
    return app;
  } catch {
    await infrastructure.onApplicationShutdown();
    throw new Error('Application initialization failed');
  }
}