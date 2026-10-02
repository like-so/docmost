import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { Cache } from 'cache-manager';
import {
  computeProfileHash,
  computeProfileId,
} from '../embedding/profile-hash';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import {
  EmbeddingBatchResult,
  EmbeddingPort,
  IndexProfile,
  IndexProfileConfig,
  RagError,
  RagProfileResolver,
} from '../contracts';
import { RagProfileConfigValidator } from '../http/rag-profile-validator';

/** Minimal cache stub: withCache falls back to the source on cache errors. */
export const cacheStub = {
  get: async () => undefined,
  set: async () => undefined,
  del: async () => undefined,
} as unknown as Cache;

export function buildPermissionRepos(db: Kysely<DbInterface>): {
  pagePermissionRepo: PagePermissionRepo;
  spaceMemberRepo: SpaceMemberRepo;
} {
  const groupRepo = new GroupRepo(db);
  const spaceRepo = new SpaceRepo(db, new EventEmitter2());
  return {
    pagePermissionRepo: new PagePermissionRepo(db, groupRepo, cacheStub),
    spaceMemberRepo: new SpaceMemberRepo(db, groupRepo, spaceRepo, cacheStub),
  };
}

export function makeUser(workspaceId: string, id = randomUUID()): User {
  return { id, workspaceId, email: `${id}@example.com` } as unknown as User;
}

export async function seedUser(
  db: Kysely<DbInterface>,
  user: User,
): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: user.id,
      workspaceId: user.workspaceId,
      email: `${user.id}@example.com`,
      name: 'rag-test-user',
    })
    .execute();
}

export async function seedSpaceMember(
  db: Kysely<DbInterface>,
  spaceId: string,
  userId: string,
  role: 'reader' | 'writer' | 'admin',
): Promise<void> {
  await db
    .insertInto('spaceMembers')
    .values({ id: randomUUID(), spaceId, userId, role })
    .execute();
}

/** Restricts a page to explicit page-level grants (pageAccess row). */
export async function seedPageRestriction(
  db: Kysely<DbInterface>,
  page: { id: string; workspaceId: string; spaceId: string },
): Promise<string> {
  const pageAccessId = randomUUID();
  await db
    .insertInto('pageAccess')
    .values({
      id: pageAccessId,
      pageId: page.id,
      workspaceId: page.workspaceId,
      spaceId: page.spaceId,
      accessLevel: 'writer',
    })
    .execute();
  return pageAccessId;
}

export async function seedPagePermission(
  db: Kysely<DbInterface>,
  pageAccessId: string,
  userId: string,
  role: 'reader' | 'writer',
): Promise<void> {
  // The foundation table is unique on (page_access_id, user_id); a reseed
  // upgrades the grant instead of violating the constraint.
  await db
    .insertInto('pagePermissions')
    .values({ id: randomUUID(), pageAccessId, userId, role })
    .onConflict((conflict) =>
      conflict.columns(['pageAccessId', 'userId']).doUpdateSet({ role }),
    )
    .execute();
}

/**
 * Deterministic fixture EmbeddingPort. Query vectors come from an explicit
 * lookup table the test configures, so similarity orderings are exact and no
 * real embedding API is involved.
 */
export class FixtureEmbeddingPort implements EmbeddingPort {
  constructor(
    private readonly vectors: Record<string, number[]>,
    private readonly profileHash: string,
  ) {}

  async embedQuery(
    workspaceId: string,
    _indexProfile: IndexProfile,
    query: string,
  ) {
    const values = this.vectors[query];
    if (!values) {
      throw new RagError('EMBEDDING_NOT_CONFIGURED');
    }
    return { profileHash: this.profileHash, dimensions: values.length, values };
  }

  async embed(): Promise<EmbeddingBatchResult> {
    throw new RagError('EMBEDDING_NOT_CONFIGURED');
  }
}

export class FixtureProfileResolver implements RagProfileResolver {
  constructor(private readonly profile: IndexProfile) {}

  async resolve(_workspaceId: string): Promise<IndexProfile> {
    return this.profile;
  }
}

const SUPPORTED_DRIVERS = ['openai-compatible'];

/**
 * Fixture validator standing in for the embedding component's real profile
 * resolution: rejects unsupported drivers/configurations and derives a
 * deterministic profileHash over the whole config.
 */
export class FixtureProfileValidator implements RagProfileConfigValidator {
  validate(_workspace: Workspace, config: IndexProfileConfig): IndexProfile {
    if (!SUPPORTED_DRIVERS.includes(config.embedding.driver)) {
      throw new RagError('EMBEDDING_NOT_CONFIGURED');
    }
    if (
      config.overlapTokens < 0 ||
      config.overlapTokens >= config.maxChunkTokens
    ) {
      throw new RagError('SOURCE_UNSUPPORTED');
    }
    // The shared hash is canonical (sorted keys), so a profile identity
    // survives the jsonb round-trip through workspace settings.
    const profileHash = computeProfileHash(config);
    // The foundation persistence stores profileId in a uuid column; derive a
    // deterministic uuid-shaped id from the profile hash.
    return {
      ...config,
      profileId: computeProfileId(profileHash),
      profileHash,
    };
  }
}
