import { Controller, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { InvitesService } from '../invites/invites.service.js';

@Controller('api/users')
export class ProfileController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @Post('source-scene')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  sourceScene(@Req() request: Request) { return this.invites.sourceScene(request); }

  @Post('profile')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  profile(@Req() request: Request) { return this.invites.profile(request); }
}
