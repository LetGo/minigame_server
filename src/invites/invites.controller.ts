import { Controller, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { InvitesService } from './invites.service.js';

@Controller('api/invites')
export class InvitesController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @Post('report')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  report(@Req() request: Request) { return this.invites.report(request); }

  @Post('list')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  list(@Req() request: Request) { return this.invites.list(request); }

  @Post('claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  claim(@Req() request: Request) { return this.invites.claim(request); }
}
