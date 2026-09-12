import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceService } from '../space/services/space.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { User } from '@docmost/db/types/entity.types';
import { allowsPersonalSpaces } from './personal-space.policy';

@Injectable()
export class PersonalSpaceService {
  constructor(
    private readonly spaces: SpaceRepo,
    private readonly spaceService: SpaceService,
    private readonly workspaces: WorkspaceRepo,
  ) {}

  async getOrCreate(user: User, workspaceId: string) {
    await this.assertEnabled(workspaceId);
    const existing = await this.spaces.findPersonalSpace(user.id, workspaceId);
    if (existing) return existing;
    try {
      return await this.spaceService.createSpace(
        user,
        workspaceId,
        {
          name: `${user.name}'s space`,
          slug: `personal-${user.id}`,
          description: 'Private personal space',
        },
        undefined,
        { isPersonal: true },
      );
    } catch (error) {
      const created = await this.spaces.findPersonalSpace(user.id, workspaceId);
      if (created) return created;
      if (error instanceof ConflictException) throw error;
      throw error;
    }
  }

  async assertOwner(user: User, workspaceId: string, spaceId: string) {
    await this.assertEnabled(workspaceId);
    const space = await this.spaces.findPersonalSpace(user.id, workspaceId);
    if (!space || space.id !== spaceId) throw new ForbiddenException();
    return space;
  }

  private async assertEnabled(workspaceId: string) {
    const workspace = await this.workspaces.findById(workspaceId);
    if (!allowsPersonalSpaces(workspace))
      throw new ForbiddenException('Personal spaces are disabled');
  }
}
