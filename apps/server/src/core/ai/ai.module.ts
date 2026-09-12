import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { McpController } from './mcp.controller';
import { AiIndexService } from './ai-index.service';
import { AiProcessor } from './ai.processor';
import { AttachmentModule } from '../attachment/attachment.module';

@Module({
  imports: [SearchModule, AttachmentModule],
  controllers: [AiController, McpController],
  providers: [AiService, AiIndexService, AiProcessor],
})
export class AiModule {}
