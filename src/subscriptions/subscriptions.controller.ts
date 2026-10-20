import {Controller,Header,HttpCode,Inject,Post,Req} from '@nestjs/common';
import type {Request} from 'express';
import {SubscriptionsService} from './subscriptions.service.js';
@Controller('api/subscriptions/checkin')
export class SubscriptionsController {
 constructor(@Inject(SubscriptionsService) private readonly subscriptions:SubscriptionsService){}
 @Post('template') @HttpCode(200) @Header('Cache-Control','no-store')
 template(@Req() request:Request){return this.subscriptions.template(request);}
 @Post('report') @HttpCode(200) @Header('Cache-Control','no-store')
 report(@Req() request:Request){return this.subscriptions.report(request);}
}
