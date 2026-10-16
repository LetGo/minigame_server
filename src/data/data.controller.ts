import { Controller, Header, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { DataService } from './data.service.js';

@Controller('api/data')
export class DataController {
  constructor(@Inject(DataService) private readonly data: DataService) {}

  @Post('save')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  save(@Req() request: Request) { return this.data.save(request); }

  @Post('get')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  get(@Req() request: Request) { return this.data.get(request); }
}
