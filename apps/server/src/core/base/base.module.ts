import { Module } from '@nestjs/common';
import { PageModule } from '../page/page.module';
import { BaseController } from './base.controller';
import { BaseService } from './base.service';
@Module({ imports: [PageModule], controllers: [BaseController], providers: [BaseService], exports: [BaseService] })
export class BaseModule {}
