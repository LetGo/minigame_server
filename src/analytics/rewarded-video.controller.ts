import {Controller,Header,HttpCode,Inject,Post,Req} from '@nestjs/common';
import {Request} from 'express';
import {RewardedVideoService} from './rewarded-video.service.js';

@Controller('api/analytics/rewarded-video')
export class RewardedVideoController {
 constructor(@Inject(RewardedVideoService) private readonly videos:RewardedVideoService) {}
 @Post('completed')
 @HttpCode(200)
 @Header('Cache-Control','no-store')
 completed(@Req() request:Request) {return this.videos.completed(request);}
}
