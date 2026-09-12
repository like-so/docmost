import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { MfaPolicy } from '../ports/mfa-policy';

@Injectable()
export class DatabaseMfaPolicy implements MfaPolicy {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async requiresChallenge(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const [workspace, userMfa] = await Promise.all([
      this.db
        .selectFrom('workspaces')
        .select('enforceMfa')
        .where('id', '=', workspaceId)
        .executeTakeFirst(),
      this.db
        .selectFrom('userMfa')
        .select('isEnabled')
        .where('userId', '=', userId)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst(),
    ]);
    return Boolean(workspace?.enforceMfa || userMfa?.isEnabled);
  }
}
