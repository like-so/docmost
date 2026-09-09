import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PersonalSpaceService } from './personal-space.service';

@UseGuards(JwtAuthGuard)
@Controller('personal-space')
export class PersonalSpaceController {
  constructor(private readonly personal: PersonalSpaceService) {}
  @Post()
  @HttpCode(HttpStatus.OK)
  getOrCreate(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.personal.getOrCreate(user, workspace.id);
  }
}
