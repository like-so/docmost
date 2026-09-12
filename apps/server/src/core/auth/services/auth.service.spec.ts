import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

const workspaceId = 'workspace-id';
const providerId = 'provider-id';
const identity = {
  subject: 'subject-id',
  email: 'PERSON@example.com',
  emailVerified: true,
  name: 'Person',
};
const user = { id: 'user-id', workspaceId, name: 'Old name' } as any;

describe('AuthService federated identity resolution', () => {
  let service: AuthService;
  let provider: any;
  let account: any;
  let inserted: any;
  let userRepo: any;
  let signup: any;
  let session: any;
  let groups: any;
  let mfaGate: any;
  let database: any;

  beforeEach(() => {
    provider = {
      allowSignup: false,
      settings: { allowedDomains: 'example.com' },
    };
    account = undefined;
    inserted = { userId: user.id };
    userRepo = { findByEmail: jest.fn(), updateUser: jest.fn() };
    signup = { signup: jest.fn() };
    session = { createSessionAndToken: jest.fn().mockResolvedValue('token') };
    groups = { syncUserGroups: jest.fn() };
    mfaGate = { requiresChallenge: jest.fn().mockResolvedValue(false) };
    database = createDatabase();
    service = new AuthService(
      signup,
      {} as any,
      session,
      {} as any,
      userRepo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mfaGate,
      {} as any,
      groups,
      database,
      {} as any,
    );
  });

  it('links a same-workspace matching email atomically and updates its profile', async () => {
    userRepo.findByEmail.mockResolvedValue(user);

    await expect(
      service.loginFederated(providerId, identity, workspaceId),
    ).resolves.toEqual({ authToken: 'token' });

    expect(userRepo.findByEmail).toHaveBeenCalledWith(
      identity.email,
      workspaceId,
      expect.anything(),
    );
    expect(userRepo.updateUser).toHaveBeenCalledWith(
      { name: 'Person' },
      user.id,
      workspaceId,
    );
    expect(signup.signup).not.toHaveBeenCalled();
  });

  it('rejects unverified OIDC identity email and disallowed domains before lookup', async () => {
    await expect(
      service.loginFederated(
        providerId,
        { ...identity, emailVerified: false },
        workspaceId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.loginFederated(
        providerId,
        { ...identity, email: 'person@other.example' },
        workspaceId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
  });

  it.each(['OIDC', 'SAML', 'LDAP'])(
    'rejects an existing %s account when its current identity is ineligible',
    async () => {
      account = user;

      await expect(
        service.loginFederated(
          providerId,
          { ...identity, emailVerified: false },
          workspaceId,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        service.loginFederated(
          providerId,
          { ...identity, email: 'person@other.example' },
          workspaceId,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(session.createSessionAndToken).not.toHaveBeenCalled();
      expect(userRepo.updateUser).not.toHaveBeenCalled();
    },
  );

  it('partitions group synchronization by the authenticating provider', async () => {
    userRepo.findByEmail.mockResolvedValue(user);

    await service.loginFederated(
      providerId,
      { ...identity, groups: ['Engineering'] },
      workspaceId,
    );

    expect(groups.syncUserGroups).toHaveBeenCalledWith(
      workspaceId,
      user.id,
      providerId,
      ['Engineering'],
    );
  });

  it('rejects unknown identities while signup is disabled', async () => {
    userRepo.findByEmail.mockResolvedValue(undefined);

    await expect(
      service.loginFederated(providerId, identity, workspaceId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(signup.signup).not.toHaveBeenCalled();
  });

  it('creates and links an eligible identity only when signup is enabled', async () => {
    provider.allowSignup = true;
    signup.signup.mockResolvedValue(user);

    await expect(
      service.loginFederated(providerId, identity, workspaceId),
    ).resolves.toEqual({ authToken: 'token' });

    expect(signup.signup).toHaveBeenCalledWith(
      expect.objectContaining({
        email: identity.email,
        name: identity.name,
        emailVerifiedAt: expect.any(Date),
      }),
      workspaceId,
      expect.anything(),
    );
  });

  it('rejects a repository result outside the workspace without linking it', async () => {
    userRepo.findByEmail.mockResolvedValue({
      ...user,
      workspaceId: 'other-workspace',
    });

    await expect(
      service.loginFederated(providerId, identity, workspaceId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(['deactivatedAt', 'deletedAt'] as const)(
    'rejects a matching-email user with %s before linking or login side effects',
    async (status) => {
      userRepo.findByEmail.mockResolvedValue({ ...user, [status]: new Date() });

      await expect(
        service.loginFederated(
          providerId,
          { ...identity, groups: ['Engineering'] },
          workspaceId,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(database.insertAuthAccount).not.toHaveBeenCalled();
      expect(userRepo.updateUser).not.toHaveBeenCalled();
      expect(groups.syncUserGroups).not.toHaveBeenCalled();
      expect(mfaGate.requiresChallenge).not.toHaveBeenCalled();
      expect(session.createSessionAndToken).not.toHaveBeenCalled();
    },
  );

  it('rejects a subject collision rather than taking over its linked account', async () => {
    userRepo.findByEmail.mockResolvedValue(user);
    inserted = undefined;

    await expect(
      service.loginFederated(providerId, identity, workspaceId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  function createDatabase(): any {
    const insertAuthAccount = jest.fn(() => insertQuery());
    const transaction = { insertInto: insertAuthAccount };
    return {
      selectFrom: jest.fn((table) => selectQuery(table)),
      transaction: jest.fn(() => ({
        execute: (callback) => callback(transaction),
      })),
      insertAuthAccount,
    };
  }

  function selectQuery(table: string): any {
    const query: any = {
      innerJoin: jest.fn(() => query),
      select: jest.fn(() => query),
      selectAll: jest.fn(() => query),
      where: jest.fn(() => query),
      executeTakeFirst: jest.fn(async () =>
        table === 'authAccounts' ? account : provider,
      ),
    };
    return query;
  }

  function insertQuery(): any {
    const query: any = {
      values: jest.fn(() => query),
      onConflict: jest.fn((callback) => {
        callback({ columns: () => ({ doNothing: () => undefined }) });
        return query;
      }),
      returning: jest.fn(() => query),
      executeTakeFirst: jest.fn(async () => inserted),
    };
    return query;
  }
});
