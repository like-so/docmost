import { ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AuthProviderController } from './auth-provider.controller';
import { CreateAuthProviderDto } from './dto/create-auth-provider.dto';
import { UpdateAuthProviderDto } from './dto/update-auth-provider.dto';

describe('Administrator provider connection information', () => {
  const workspace = { id: 'workspace-a', hostname: 'team' } as any;
  const user = { id: 'administrator' } as any;
  let providers: any;
  let ability: any;
  let environment: any;
  let domain: any;
  let controller: AuthProviderController;

  beforeEach(() => {
    providers = { create: jest.fn(), list: jest.fn(), update: jest.fn(), listEnabled: jest.fn() };
    ability = { cannot: jest.fn().mockReturnValue(false) };
    environment = { isCloud: jest.fn().mockReturnValue(false), getSubdomainHost: jest.fn() };
    domain = { getUrl: jest.fn().mockReturnValue('https://docs.example.test:7443') };
    controller = new AuthProviderController(providers, { createForUser: () => ability } as any,
      { assertEnabled: jest.fn() } as any, domain, environment);
  });

  it('prepares actual URLs before configuration without persisting an incomplete provider', () => {
    const draft = controller.prepare(user, workspace);
    expect(draft.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(draft.connectionInfo).toEqual({
      oidcCallbackUrl: `https://docs.example.test:7443/api/sso/${draft.id}/callback`,
      samlEntityId: `https://docs.example.test:7443/api/sso/saml/${draft.id}/login`,
      samlAcsUrl: `https://docs.example.test:7443/api/sso/saml/${draft.id}/callback`,
    });
    expect(domain.getUrl).toHaveBeenCalledWith(workspace.hostname);
    expect(providers.create).not.toHaveBeenCalled();
  });

  it('keeps prepared, created, disabled and re-enabled URLs identical', async () => {
    const draft = controller.prepare(user, workspace);
    const saved = { id: draft.id, type: 'oidc', name: 'Corporate login', isEnabled: false };
    providers.create.mockResolvedValue(saved);
    providers.list.mockResolvedValue([saved]);
    providers.update.mockImplementation(async (_workspace: string, _user: unknown, id: string, patch: any) => ({ ...saved, ...patch, id }));
    const created = await controller.create({ preparedId: draft.id, type: 'oidc', name: saved.name, oidcIssuer: 'https://issuer.example', oidcClientId: 'client' } as any, user, workspace);
    const disabled = await controller.update({ id: draft.id, isEnabled: false } as any, user, workspace);
    const enabled = await controller.update({ id: draft.id, isEnabled: true } as any, user, workspace);
    expect(created.connectionInfo).toEqual(draft.connectionInfo);
    expect(disabled.connectionInfo).toEqual(draft.connectionInfo);
    expect(enabled.connectionInfo).toEqual(draft.connectionInfo);
    expect((await controller.list(user, workspace))[0].connectionInfo).toEqual(draft.connectionInfo);
  });

  it('uses the server workspace domain for cloud URLs, never request/browser origin', () => {
    environment.isCloud.mockReturnValue(true);
    environment.getSubdomainHost.mockReturnValue('cloud.example');
    domain.getUrl.mockReturnValue('https://team.cloud.example');
    expect(controller.prepare(user, workspace).connectionInfo.oidcCallbackUrl).toMatch(/^https:\/\/team\.cloud\.example\/api\/sso\//);
    domain.getUrl.mockReturnValue('https://other.cloud.example');
    expect(() => controller.prepare(user, workspace)).toThrow();
  });

  it('denies connection preparation to users without settings permission', () => {
    ability.cannot.mockReturnValue(true);
    expect(() => controller.prepare(user, workspace)).toThrow(ForbiddenException);
    expect(domain.getUrl).not.toHaveBeenCalled();
  });

  it('validates the optional prepared UUID and keeps update IDs required', async () => {
    const create = plainToInstance(CreateAuthProviderDto, { preparedId: 'not-a-uuid', name: 'Login', type: 'oidc' });
    expect((await validate(create)).some((error) => error.property === 'preparedId')).toBe(true);
    const update = plainToInstance(UpdateAuthProviderDto, { isEnabled: false });
    expect((await validate(update)).some((error) => error.property === 'id')).toBe(true);
  });
});
