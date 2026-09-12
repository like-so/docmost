import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { User } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { PagePermissionGrantDto } from './dto/page-permission.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';

@Injectable()
export class PagePermissionService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly userRepo: UserRepo,
    private readonly groupRepo: GroupRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async getPermissions(
    pageId: string,
    user: User,
    workspaceId: string,
    pagination: PaginationOptions,
  ) {
    const page = await this.getManagedPage(pageId, user, workspaceId);
    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );

    if (!pageAccess) {
      const inherited = await this.pagePermissionRepo.findRestrictedAncestor(
        page.id,
      );
      return {
        accessLevel: 'inherited' as const,
        inheritedFromPageId: inherited?.depth ? inherited.pageId : null,
        members: [],
      };
    }

    return {
      accessLevel: 'restricted' as const,
      inheritedFromPageId: null,
      members: await this.pagePermissionRepo.getPagePermissionsPaginated(
        pageAccess.id,
        pagination,
      ),
    };
  }

  async updatePermissions(
    pageId: string,
    user: User,
    workspaceId: string,
    inherit: boolean,
    members: PagePermissionGrantDto[],
  ) {
    const page = await this.getManagedPage(pageId, user, workspaceId);
    if (inherit) {
      const changed = await executeTx(this.db, async (trx) => {
        const access = await this.pagePermissionRepo.findPageAccessByPageId(
          page.id,
          trx,
        );
        if (!access) return false;
        await this.pagePermissionRepo.deletePageAccess(page.id, trx);
        return true;
      });
      if (changed) {
        await this.pagePermissionRepo.invalidatePermissionCache(page.id, workspaceId);
      }
      return { accessLevel: 'inherited' as const };
    }

    this.assertUniqueMembers(members);
    await this.assertMembersExist(members, workspaceId);
    await executeTx(this.db, async (trx) => {
      const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
        page.id,
        trx,
      );
      const access =
        pageAccess ??
        (await this.pagePermissionRepo.insertPageAccess(
          {
            pageId: page.id,
            workspaceId,
            spaceId: page.spaceId,
            accessLevel: 'restricted',
            creatorId: user.id,
          },
          trx,
        ));
      await this.pagePermissionRepo.deletePagePermissions(access.id, trx);
      await this.pagePermissionRepo.insertPagePermissions(
        this.withEditor(members, user.id).map((member) => ({
          pageAccessId: access.id,
          userId: member.userId,
          groupId: member.groupId,
          role: member.role,
          addedById: user.id,
        })),
        trx,
      );
    });
    await this.pagePermissionRepo.invalidatePermissionCache(page.id, workspaceId);

    return { accessLevel: 'restricted' as const };
  }

  private async getManagedPage(pageId: string, user: User, workspaceId: string) {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== workspaceId || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
    return page;
  }

  private assertUniqueMembers(members: PagePermissionGrantDto[]): void {
    if (members.some((member) => Boolean(member.userId) === Boolean(member.groupId))) {
      throw new BadRequestException('Each permission must identify one member');
    }
    const identifiers = members.map(
      (member) => `${member.userId ? 'user' : 'group'}:${member.userId ?? member.groupId}`,
    );
    if (identifiers.some((id, index) => identifiers.indexOf(id) !== index)) {
      throw new BadRequestException('Permission members must be unique');
    }
  }

  private async assertMembersExist(
    members: PagePermissionGrantDto[],
    workspaceId: string,
  ): Promise<void> {
    await Promise.all(
      members.map(async (member) => {
        const found = member.userId
          ? await this.userRepo.findById(member.userId, workspaceId)
          : await this.groupRepo.findById(member.groupId, workspaceId);
        if (!found) throw new BadRequestException('Permission member not found');
      }),
    );
  }

  private withEditor(members: PagePermissionGrantDto[], userId: string) {
    const actor = members.find((member) => member.userId === userId);
    if (actor) return members.map((member) =>
      member === actor ? { ...member, role: 'writer' as const } : member,
    );
    return [...members, { userId, role: 'writer' as const }];
  }
}
