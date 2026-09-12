import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { WorkspaceInvitationService } from './workspace-invitation.service';

const workspace = {
  id: 'workspace-a',
  hostname: 'a.test',
  enforceMfa: false,
  enforceSso: false,
} as any;

const invitation = {
  id: 'invite',
  token: 'token',
  email: 'person@example.com',
  role: 'member',
  invitedById: 'owner',
  groupIds: [],
} as any;

function createFixture(opts: { invitation?: any; workspace?: any } = {}) {
  const selected = Object.prototype.hasOwnProperty.call(opts, 'invitation')
    ? opts.invitation
    : invitation;
  const selectedWorkspace = opts.workspace ?? workspace;
  const events: string[] = [];
  const where = jest.fn();
  const select = {
    select: jest.fn(),
    selectAll: jest.fn(),
    where: jest.fn((...args: unknown[]) => {
      where(...args);
      return select;
    }),
    executeTakeFirst: jest.fn().mockResolvedValue(selected),
  };
  select.select.mockReturnValue(select);
  select.selectAll.mockReturnValue(select);
  const deletion = {
    where: jest.fn(() => deletion),
    execute: jest.fn(async () => {
      events.push('delete');
    }),
  };
  const trx = { deleteFrom: jest.fn(() => deletion) };
  const db: any = {
    deleteFrom: jest.fn(() => deletion),
    selectFrom: jest.fn(() => select),
    transaction: jest.fn(() => ({
      execute: jest.fn(async (callback: (value: typeof trx) => Promise<void>) => {
        await callback(trx);
        events.push('commit');
      }),
    })),
  };
  const users = {
    insertUser: jest.fn(async () => {
      events.push('insert-user');
      return { id: 'new-user', name: 'Person', email: invitation.email };
    }),
    findById: jest.fn(async () => ({ email: 'owner@example.com' })),
  };
  const groups = {
    addUserToDefaultGroup: jest.fn(async () => {
      events.push('default-group');
    }),
  };
  const mail = {
    sendToQueue: jest.fn(async () => {
      events.push('mail');
    }),
  };
  const audit = {
    log: jest.fn(async () => {
      events.push('audit');
    }),
  };
  const session = {
    createSessionAndToken: jest.fn(async () => {
      events.push('session');
      return 'auth-token';
    }),
  };
  const service = new WorkspaceInvitationService(
    users as any,
    groups as any,
    mail as any,
    {} as any,
    {} as any,
    session as any,
    db,
    {} as any,
    { isCloud: () => false } as any,
    audit as any,
  );

  return {
    audit,
    db,
    deletion,
    events,
    mail,
    select,
    service,
    session,
    selectedWorkspace,
    users,
    where,
  };
}

describe('WorkspaceInvitationService', () => {
  it('rejects missing or wrong-token acceptance before transaction side effects', async () => {
    const missing = createFixture({ invitation: undefined });
    await expect(
      missing.service.acceptInvitation(
        { invitationId: 'invite', token: 'token' } as any,
        workspace,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(missing.db.transaction).not.toHaveBeenCalled();

    const wrongToken = createFixture();
    await expect(
      wrongToken.service.acceptInvitation(
        { invitationId: 'invite', token: 'wrong' } as any,
        workspace,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(wrongToken.db.transaction).not.toHaveBeenCalled();
    expect(wrongToken.mail.sendToQueue).not.toHaveBeenCalled();
    expect(wrongToken.audit.log).not.toHaveBeenCalled();
    expect(wrongToken.session.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('scopes invitation reads to the supplied workspace', async () => {
    const fixture = createFixture({ invitation: undefined });
    await expect(
      fixture.service.getInvitationById('invite', fixture.selectedWorkspace),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(fixture.where).toHaveBeenCalledWith('id', '=', 'invite');
    expect(fixture.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      'workspace-a',
    );
  });

  it('scopes revocation lookup and deletion before audit', async () => {
    const fixture = createFixture({ invitation: undefined });
    await fixture.service.revokeInvitation('invite', 'workspace-a');

    expect(fixture.where).toHaveBeenCalledWith('id', '=', 'invite');
    expect(fixture.where).toHaveBeenCalledWith(
      'workspaceId',
      '=',
      'workspace-a',
    );
    expect(fixture.deletion.where).toHaveBeenNthCalledWith(1, 'id', '=', 'invite');
    expect(fixture.deletion.where).toHaveBeenNthCalledWith(
      2,
      'workspaceId',
      '=',
      'workspace-a',
    );
    expect(fixture.audit.log).not.toHaveBeenCalled();
  });

  it('deletes the accepted invitation in its transaction before post-commit effects', async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.acceptInvitation(
        { invitationId: 'invite', token: 'token', name: 'Person' } as any,
        workspace,
      ),
    ).resolves.toEqual({ authToken: 'auth-token' });

    expect(fixture.deletion.where).toHaveBeenCalledWith('id', '=', 'invite');
    expect(fixture.events).toEqual([
      'insert-user',
      'default-group',
      'delete',
      'commit',
      'mail',
      'audit',
      'session',
    ]);
  });

  it('rejects enforced SSO before committed invitation side effects', async () => {
    const fixture = createFixture({
      workspace: { ...workspace, enforceSso: true },
    });
    await expect(
      fixture.service.acceptInvitation(
        { invitationId: 'invite', token: 'token' } as any,
        fixture.selectedWorkspace,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.db.transaction).not.toHaveBeenCalled();
    expect(fixture.users.insertUser).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it('rejects unapproved invitation domains before committed invitation side effects', async () => {
    const fixture = createFixture({
      workspace: { ...workspace, emailDomains: ['allowed.test'] },
    });
    await expect(
      fixture.service.acceptInvitation(
        { invitationId: 'invite', token: 'token' } as any,
        fixture.selectedWorkspace,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fixture.db.transaction).not.toHaveBeenCalled();
    expect(fixture.users.insertUser).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });
});
