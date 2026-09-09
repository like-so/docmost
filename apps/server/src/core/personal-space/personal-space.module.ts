import { Module } from '@nestjs/common';
import { SpaceModule } from '../space/space.module';
import { PersonalSpaceController } from './personal-space.controller';
import { PersonalSpaceService } from './personal-space.service';
@Module({
  imports: [SpaceModule],
  controllers: [PersonalSpaceController],
  providers: [PersonalSpaceService],
  exports: [PersonalSpaceService],
})
export class PersonalSpaceModule {}
