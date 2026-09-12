import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  PasswordInput,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { ProviderForm } from "@/features/security/components/provider-form.tsx";
import { ProviderConnectionDetails } from "@/features/security/components/provider-connection-details";
import {
  useCreateProvider,
  useCreateScimToken,
  useDeleteProvider,
  useProviders,
  usePrepareProvider,
  useRevokeScimToken,
  useScimTokens,
  useUpdateProvider,
  useUpdateSecurity,
} from "@/features/security/queries/security-query.ts";
import {
  AuthProvider,
  NewScimToken,
  ProviderInput,
  PreparedProvider,
} from "@/features/security/types/security.types.ts";
import { useWorkspaceQuery } from "@/features/workspace/queries/workspace-query.ts";
import { prepareProviderInput } from "@/features/security/utils/provider-input.ts";
import { canManageScim } from "@/features/security/utils/scim-access.ts";
import useUserRole from "@/hooks/use-user-role.tsx";

function getErrorMessage(error: unknown): string {
  return (
    error?.["response"]?.data?.message ?? "Unable to update security settings"
  );
}

export default function SecuritySettings() {
  const { isAdmin, isOwner } = useUserRole();
  const { data: workspace } = useWorkspaceQuery();
  const { data: providers = [] } = useProviders(isAdmin);
  const { data: tokens = [] } = useScimTokens(canManageScim(isOwner));
  const createProvider = useCreateProvider();
  const prepareProvider = usePrepareProvider();
  const [preparedProvider, setPreparedProvider] = useState<PreparedProvider>();
  const updateProvider = useUpdateProvider();
  const deleteProvider = useDeleteProvider();
  const updateSecurity = useUpdateSecurity();
  const createToken = useCreateScimToken();
  const revokeToken = useRevokeScimToken();
  const [editing, setEditing] = useState<AuthProvider>();
  const [adding, setAdding] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [newToken, setNewToken] = useState<NewScimToken>();
  const hasEnabledProvider = providers.some((provider) => provider.isEnabled);

  function reportError(error: unknown) {
    notifications.show({ message: getErrorMessage(error), color: "red" });
  }

  async function startAdding() {
    try {
      const prepared = await prepareProvider.mutateAsync();
      setPreparedProvider(prepared);
      setAdding(true);
    } catch (error) {
      reportError(error);
    }
  }

  async function saveProvider(data: ProviderInput) {
    try {
      if (editing) {
        await updateProvider.mutateAsync({
          id: editing.id,
          data: prepareProviderInput(data),
        });
      } else {
        await createProvider.mutateAsync(prepareProviderInput(data));
      }
      setAdding(false);
      setEditing(undefined);
    } catch (error) {
      reportError(error);
    }
  }

  async function changeProvider(provider: AuthProvider, enabled: boolean) {
    try {
      await updateProvider.mutateAsync({
        id: provider.id,
        data: { isEnabled: enabled },
      });
    } catch (error) {
      reportError(error);
    }
  }

  async function removeProvider(provider: AuthProvider) {
    try {
      await deleteProvider.mutateAsync(provider.id);
    } catch (error) {
      reportError(error);
    }
  }

  async function changeSecurity(data: {
    enforceSso?: boolean;
    enforceMfa?: boolean;
    isScimEnabled?: boolean;
    enforceMcpOauth?: boolean;
  }) {
    try {
      await updateSecurity.mutateAsync(data);
    } catch (error) {
      reportError(error);
    }
  }

  async function addToken() {
    try {
      setNewToken(await createToken.mutateAsync(tokenName));
      setTokenName("");
    } catch (error) {
      reportError(error);
    }
  }

  async function removeToken(tokenId: string) {
    try {
      await revokeToken.mutateAsync(tokenId);
    } catch (error) {
      reportError(error);
    }
  }

  if (!isAdmin) {
    return (
      <Alert color="red">
        Only workspace administrators can manage security settings.
      </Alert>
    );
  }

  return (
    <>
      <DocumentTitle title="Security & SSO" />
      <SettingsTitle title="Security & SSO" />
      <Stack gap="md">
        <Alert color="yellow">
          Keep at least one workspace owner able to sign in with a password
          before enforcing SSO. Owners can use password recovery if every
          identity provider is unavailable.
        </Alert>
        <Switch
          checked={workspace?.enforceSso ?? false}
          disabled={!hasEnabledProvider || updateSecurity.isPending}
          label="Enforce single sign-on"
          description={
            hasEnabledProvider
              ? "Members must use an enabled identity provider."
              : "Enable an identity provider before enforcing SSO."
          }
          onChange={(event) =>
            changeSecurity({ enforceSso: event.currentTarget.checked })
          }
        />
        <Switch
          checked={workspace?.enforceMfa ?? false}
          disabled={updateSecurity.isPending}
          label="Require multi-factor authentication"
          description="Members are prompted to configure multi-factor authentication at sign-in."
          onChange={(event) =>
            changeSecurity({ enforceMfa: event.currentTarget.checked })
          }
        />
        <Switch
          checked={workspace?.settings?.ai?.enforceMcpOauth === true}
          disabled={workspace?.settings?.ai?.mcp !== true || updateSecurity.isPending}
          label="Require OAuth for MCP"
          description="Reject browser sessions and API keys for MCP requests."
          onChange={(event) =>
            changeSecurity({ enforceMcpOauth: event.currentTarget.checked })
          }
        />

        <Divider />
        <Group justify="space-between">
          <Text fw={600}>Identity providers</Text>
          <Button loading={prepareProvider.isPending} onClick={startAdding}>Add provider</Button>
        </Group>
        {providers.map((provider) => (
          <Card key={provider.id} withBorder>
            <Group justify="space-between">
              <div>
                <Text fw={500}>{provider.name}</Text>
                <Badge variant="light">{provider.type.toUpperCase()}</Badge>
                {provider.groupSync && (
                  <Badge ml="xs" variant="light">
                    Group sync
                  </Badge>
                )}
              </div>
              <Group>
                <Switch
                  checked={provider.isEnabled}
                  disabled={updateProvider.isPending}
                  aria-label={`Enable ${provider.name}`}
                  onChange={(event) =>
                    changeProvider(provider, event.currentTarget.checked)
                  }
                />
                <Button variant="default" onClick={() => setEditing(provider)}>
                  Edit
                </Button>
                <Button
                  color="red"
                  variant="subtle"
                  onClick={() => removeProvider(provider)}
                >
                  Delete
                </Button>
              </Group>
            </Group>
            <ProviderConnectionDetails type={provider.type} connectionInfo={provider.connectionInfo} />
          </Card>
        ))}
        {providers.length === 0 && (
          <Text c="dimmed">No identity providers configured.</Text>
        )}

        {canManageScim(isOwner) && (
          <>
            <Divider />
            <Text fw={600}>SCIM provisioning</Text>
            <Switch
              checked={workspace?.isScimEnabled ?? false}
              disabled={updateSecurity.isPending}
              label="Enable SCIM provisioning"
              description="Only workspace owners can create or use SCIM tokens. Disabling this rejects existing tokens."
              onChange={(event) =>
                changeSecurity({ isScimEnabled: event.currentTarget.checked })
              }
            />
            <Text size="sm" c="dimmed">
              Create a token for an external SCIM 2.0 client. Token values are
              shown once and are never displayed again.
            </Text>
            {newToken && (
              <Alert color="green" title="Copy this token now">
                <PasswordInput
                  value={newToken.token}
                  readOnly
                  visibilityToggleButtonProps={{
                    "aria-label": "Show SCIM token",
                  }}
                />
              </Alert>
            )}
            <Group align="end">
              <TextInput
                label="Token name"
                value={tokenName}
                onChange={(event) => setTokenName(event.currentTarget.value)}
              />
              <Button
                disabled={!workspace?.isScimEnabled || !tokenName.trim()}
                loading={createToken.isPending}
                onClick={addToken}
              >
                Create token
              </Button>
            </Group>
            {tokens.map((token) => (
              <Card key={token.id} withBorder>
                <Group justify="space-between">
                  <div>
                    <Text fw={500}>{token.name}</Text>
                    <Text size="sm" c="dimmed">
                      ••••{token.lastFour}
                    </Text>
                  </div>
                  <Button
                    color="red"
                    variant="subtle"
                    onClick={() => removeToken(token.id)}
                  >
                    Revoke
                  </Button>
                </Group>
              </Card>
            ))}
          </>
        )}
      </Stack>
      <Modal
        opened={adding || Boolean(editing)}
        onClose={() => {
          setAdding(false);
          setEditing(undefined);
        }}
        title={editing ? "Edit identity provider" : "Add identity provider"}
      >
        <ProviderForm
          key={editing?.id ?? preparedProvider?.id ?? "new"}
          provider={editing}
          preparedProvider={editing ? undefined : preparedProvider}
          loading={createProvider.isPending || updateProvider.isPending}
          onCancel={() => {
            setAdding(false);
            setEditing(undefined);
          }}
          onSave={saveProvider}
        />
      </Modal>
    </>
  );
}
