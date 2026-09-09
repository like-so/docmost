import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { OAuthService } from './oauth.service';
import { UserRole } from '../../common/helpers/types/permission';

const user = {
  id: 'user',
  workspaceId: 'workspace',
  role: UserRole.ADMIN,
} as any;
function db() {
  return {
    insertInto: jest.fn(() => ({
      values: jest.fn(() => ({
        returningAll: jest.fn(() => ({
          executeTakeFirstOrThrow: jest.fn().mockResolvedValue({
            id: 'client',
            redirectUris: ['https://app.example/callback'],
            scopes: ['read'],
            secretHash: 'hash',
          }),
        })),
      })),
    })),
  };
}
describe('OAuthService', () => {
  it('requires HTTPS exact redirect URI registration', async () => {
    const service = new OAuthService(db() as any, {} as any, {} as any);
    await expect(
      service.register(user, {
        name: 'app',
        redirectUris: ['http://app.example/callback'],
        scopes: ['read'],
      }),
    ).rejects.toThrow(BadRequestException);
  });
  it('rejects redirect URI mismatch and verifies S256 challenges', () => {
    const service = new OAuthService(db() as any, {} as any, {} as any);
    expect(() =>
      (service as any).assertRedirect(
        ['https://app.example/callback'],
        'https://app.example/other',
      ),
    ).toThrow(BadRequestException);
    expect((service as any).challenge('verifier')).not.toBe('verifier');
  });
  it('does not expose client secret hashes', async () => {
    const service = new OAuthService(db() as any, {} as any, {} as any);
    const result = await service.register(user, {
      name: 'app',
      redirectUris: ['https://app.example/callback'],
      scopes: ['read'],
    });
    expect(result.client).not.toHaveProperty('secretHash');
    expect(result.clientSecret).toBeTruthy();
  });

  it('persists validated scopes and returns them only for consent display', async () => {
    const values = jest.fn().mockReturnValue({ execute: jest.fn() });
    const service = new OAuthService(
      { insertInto: jest.fn().mockReturnValue({ values }) } as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'client').mockResolvedValue({
      id: 'client',
      redirectUris: ['https://app.example/callback'],
      scopes: ['read'],
    });
    await expect(
      service.startAuthorization(user, 'session', {
        clientId: 'client',
        redirectUri: 'https://app.example/callback',
        scopes: ['read'],
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      }),
    ).resolves.toMatchObject({ scope: 'read' });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['read'] }),
    );
  });

  it('rejects tampered and replayed consent confirmations', async () => {
    const pending = {
      id: 'transaction-id',
      csrfHash: (
        new OAuthService(db() as any, {} as any, {} as any) as any
      ).hash('csrf'),
      expiresAt: new Date(Date.now() + 60_000),
      redirectUri: 'https://app.example/callback',
      state: null,
    };
    const executeTakeFirst = jest.fn().mockResolvedValue(pending);
    const update = jest.fn().mockResolvedValue({ id: pending.id });
    const query = {
      selectAll: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      executeTakeFirst,
    };
    const updates = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnValue({ executeTakeFirst: update }),
    };
    const service = new OAuthService(
      {
        selectFrom: jest.fn().mockReturnValue(query),
        updateTable: jest.fn().mockReturnValue(updates),
      } as any,
      {} as any,
      {} as any,
    );
    await expect(
      service.confirmAuthorization(
        user,
        'session',
        'transaction',
        'wrong',
        false,
      ),
    ).rejects.toThrow('invalid authorization transaction');
    expect(update).not.toHaveBeenCalled();
    update.mockResolvedValueOnce(undefined);
    await expect(
      service.confirmAuthorization(
        user,
        'session',
        'transaction',
        'csrf',
        false,
      ),
    ).rejects.toThrow('invalid authorization transaction');
  });

  it.each(['revoked grant', 'deleted client', 'SCIM-deactivated user'])(
    'rejects a token with a %s',
    async () => {
      const query = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        selectAll: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        executeTakeFirst: jest.fn().mockResolvedValue(undefined),
      };
      const service = new OAuthService(
        { selectFrom: jest.fn().mockReturnValue(query) } as any,
        {} as any,
        {
          getAppUrl: jest.fn().mockReturnValue('https://docmost.example'),
        } as any,
      );
      await expect(
        service.validateOAuthToken(
          {
            workspaceId: 'workspace',
            jti: 'token',
            aud: 'client',
            iss: 'https://docmost.example',
            sub: 'user',
            scope: 'read',
          },
          'workspace',
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(query.where).toHaveBeenCalledWith(
        'oauthGrants.revokedAt',
        'is',
        null,
      );
      expect(query.where).toHaveBeenCalledWith(
        'oauthClients.deletedAt',
        'is',
        null,
      );
      expect(query.where).toHaveBeenCalledWith(
        'users.deactivatedAt',
        'is',
        null,
      );
    },
  );

  it('revokes grants and tokens when deleting a client', async () => {
    const mutation = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const query = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
    };
    const service = new OAuthService(
      {
        updateTable: jest.fn().mockReturnValue(mutation),
        selectFrom: jest.fn().mockReturnValue(query),
      } as any,
      {} as any,
      {} as any,
    );
    await service.deleteClient(user, 'client');
    expect((service as any).db.updateTable).toHaveBeenCalledWith('oauthGrants');
    expect((service as any).db.updateTable).toHaveBeenCalledWith('oauthTokens');
  });
});

describe('OAuthService audit trail', () => {
  it('records client registration only after the durable client insert', async () => {
    const audit = { logWithContext: jest.fn() };
    const service = new OAuthService(db() as any, {} as any, {} as any, audit as any);
    await service.register(user, {
      name: 'app', redirectUris: ['https://app.example/callback'], scopes: ['read'],
    });
    expect(audit.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'oauth_client.registered', resourceId: 'client' }),
      expect.objectContaining({ workspaceId: user.workspaceId, actorId: user.id }),
    );
  });
});
