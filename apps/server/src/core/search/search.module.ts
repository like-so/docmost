import { Module } from '@nestjs/common';
import {
  AttachmentSearchController,
  SearchController,
} from './search.controller';
import { SearchService } from './search.service';
import { PublicSpaceModule } from '../public-space/public-space.module';

@Module({
  imports: [PublicSpaceModule],
  controllers: [SearchController, AttachmentSearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
