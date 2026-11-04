import {Controller,Header,HttpCode,Inject,Post,Req} from '@nestjs/common';
import type {Request} from 'express';
import {LeaderboardsService} from './leaderboards.service.js';
@Controller('api/leaderboards')
export class LeaderboardsController {
 constructor(@Inject(LeaderboardsService) private readonly boards:LeaderboardsService){}
 @Post('report') @HttpCode(200) @Header('Cache-Control','no-store')
 report(@Req() request:Request){return this.boards.report(request);}
 @Post('list') @HttpCode(200) @Header('Cache-Control','no-store')
 list(@Req() request:Request){return this.boards.list(request);}
}
