import { Controller, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ShareAssistsService } from './share-assists.service.js';

@Controller('api/share-assists')
export class ShareAssistsController {
  constructor(@Inject(ShareAssistsService) private readonly assists: ShareAssistsService) {}

  @Post('report')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  report(@Req() request: Request) { return this.assists.report(request); }

  @Post('summary')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  summary(@Req() request: Request) { return this.assists.summary(request); }
}
