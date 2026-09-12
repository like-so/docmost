import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SecuritySettings from './security';

const fixture = vi.hoisted(() => ({
  providers: [] as any[], calls: [] as any[], admin: true,
  connectionInfo: {
    oidcCallbackUrl: 'https://configured.example:7443/api/sso/11111111-1111-4111-8111-111111111111/callback',
    samlEntityId: 'https://configured.example:7443/api/sso/saml/11111111-1111-4111-8111-111111111111/login',
    samlAcsUrl: 'https://configured.example:7443/api/sso/saml/11111111-1111-4111-8111-111111111111/callback',
  },
}));
vi.mock('@/features/security/services/security-service.ts', () => ({
  prepareProvider: async () => ({ id: '11111111-1111-4111-8111-111111111111', connectionInfo: fixture.connectionInfo }),
  getProviders: async () => structuredClone(fixture.providers),
  getEnabledProviders: async () => fixture.providers.filter((p) => p.isEnabled),
  createProvider: async (data: any) => {
    fixture.calls.push({ operation: 'create', data });
    const { preparedId, oidcClientSecret, ...settings } = data;
    const provider = { ...settings, id: preparedId, connectionInfo: fixture.connectionInfo };
    fixture.providers.push(provider);
    return provider;
  },
  updateProvider: async (id: string, data: any) => {
    fixture.calls.push({ operation: 'update', id, data });
    const provider = fixture.providers.find((p) => p.id === id);
    Object.assign(provider, data);
    return provider;
  },
  deleteProvider: vi.fn(), getScimTokens: async () => [], createScimToken: vi.fn(), revokeScimToken: vi.fn(), updateSecurity: vi.fn(),
}));
vi.mock('@/hooks/use-user-role.tsx', () => ({ default: () => ({ isAdmin: fixture.admin, isOwner: false }) }));
vi.mock('@/features/workspace/queries/workspace-query.ts', () => ({ useWorkspaceQuery: () => ({ data: { enforceSso: false, settings: {} } }) }));
vi.mock('@/components/ui/document-title.tsx', () => ({ DocumentTitle: () => null }));
vi.mock('@/components/settings/settings-title.tsx', () => ({ default: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { field?: string }) => key.replace('{{field}}', options?.field ?? '') }) }));
Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
afterEach(cleanup);
beforeEach(() => { fixture.providers = []; fixture.calls = []; fixture.admin = true; });
function show() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider><SecuritySettings /></MantineProvider></QueryClientProvider>);
}

describe('Administrator SSO setup flow', () => {
  it('shows the server URL before save and preserves settings through disable/re-enable/edit', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    const dialog = await screen.findByRole('dialog');
    const form = within(dialog);
    const callback = form.getByLabelText('Callback URL');
    expect(callback).toHaveProperty('value', fixture.connectionInfo.oidcCallbackUrl);
    expect(callback).toHaveProperty('readOnly', true);
    expect(form.getByRole('button', { name: 'Copy Callback URL' })).toBeTruthy();
    fireEvent.change(form.getByLabelText('Provider name', { exact: false }), { target: { value: 'Company login' } });
    fireEvent.change(form.getByLabelText('Issuer URL', { exact: false }), { target: { value: 'https://issuer.example' } });
    fireEvent.change(form.getByLabelText('Client ID', { exact: false }), { target: { value: 'client-id' } });
    fireEvent.change(form.getByLabelText('Secret', { exact: false }), { target: { value: 'private-secret' } });
    fireEvent.submit(callback.closest('form')!);
    await waitFor(() => expect(fixture.providers).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fixture.calls[0].data.preparedId).toBe('11111111-1111-4111-8111-111111111111');
    expect(fixture.calls[0].data).not.toHaveProperty('connectionInfo');
    const toggle = screen.getByRole('switch', { name: 'Enable Company login' });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveProperty('checked', false));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveProperty('checked', true));
    expect(fixture.calls.filter((x) => x.operation === 'update').map((x) => x.data)).toEqual([{ isEnabled: false }, { isEnabled: true }]);
    expect(fixture.providers[0]).toMatchObject({ oidcIssuer: 'https://issuer.example', oidcClientId: 'client-id', connectionInfo: fixture.connectionInfo });
    expect(screen.getByLabelText('Callback URL')).toHaveProperty('value', fixture.connectionInfo.oidcCallbackUrl);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = within(await screen.findByRole('dialog'));
    expect(editor.getByLabelText('Client ID', { exact: false })).toHaveProperty('value', 'client-id');
    expect(editor.getByLabelText('Replace secret (optional)')).toHaveProperty('value', '');
    fireEvent.submit(editor.getByLabelText('Callback URL').closest('form')!);
    await waitFor(() => expect(fixture.calls.filter((x) => x.operation === 'update')).toHaveLength(3));
    expect(fixture.calls.at(-1).data).not.toHaveProperty('oidcClientSecret');
  });

  it('shows distinct server-generated SAML SP Entity ID and ACS in the edit form', async () => {
    fixture.providers = [{ id: 'saml-id', name: 'SAML login', type: 'saml', isEnabled: false, allowSignup: false, samlUrl: 'https://idp.example/sso', samlEntityId: 'urn:idp', connectionInfo: fixture.connectionInfo }];
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(await screen.findByRole('dialog'));
    expect(form.getByLabelText('Entity ID (service provider)')).toHaveProperty('value', fixture.connectionInfo.samlEntityId);
    expect(form.getByLabelText('Callback URL (ACS)')).toHaveProperty('value', fixture.connectionInfo.samlAcsUrl);
    expect(form.getByLabelText('Expected IdP Entity ID', { exact: false })).toHaveProperty('value', 'urn:idp');
    expect(form.getByLabelText('IdP login URL', { exact: false })).toHaveProperty('value', 'https://idp.example/sso');
  });

  it('does not expose setup controls to a non-administrator', () => {
    fixture.admin = false;
    show();
    expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull();
    expect(screen.getByText('Only workspace administrators can manage security settings.')).toBeTruthy();
  });
});
