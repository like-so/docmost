import {
  Button,
  Checkbox,
  Group,
  PasswordInput,
  Select,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import {
  AuthProvider,
  AuthProviderKind,
  ProviderInput,
} from "@/features/security/types/security.types.ts";

interface ProviderFormProps {
  provider?: AuthProvider;
  loading?: boolean;
  onCancel?: () => void;
  onSave: (data: ProviderInput) => void;
}

const typeOptions = [
  { value: "oidc", label: "OpenID Connect" },
  { value: "saml", label: "SAML 2.0" },
  { value: "ldap", label: "LDAP" },
];

function getInitialValues(provider?: AuthProvider): ProviderInput {
  return {
    name: provider?.name ?? "",
    type: provider?.type ?? "oidc",
    isEnabled: provider?.isEnabled ?? true,
    allowSignup: provider?.allowSignup ?? false,
    groupSync: provider?.groupSync ?? false,
    oidcIssuer: provider?.oidcIssuer ?? undefined,
    oidcClientId: provider?.oidcClientId ?? undefined,
    samlUrl: provider?.samlUrl ?? undefined,
    ldapUrl: provider?.ldapUrl ?? undefined,
    ldapBindDn: provider?.ldapBindDn ?? undefined,
    ldapBaseDn: provider?.ldapBaseDn ?? undefined,
    ldapUserSearchFilter: provider?.ldapUserSearchFilter ?? undefined,
    ldapUserAttributes: provider?.ldapUserAttributes ?? {},
    ldapTlsEnabled: provider?.ldapTlsEnabled ?? false,
    settings: provider?.settings ?? {},
  };
}

export function ProviderForm({
  provider,
  loading,
  onCancel,
  onSave,
}: ProviderFormProps) {
  const form = useForm<ProviderInput>({
    initialValues: getInitialValues(provider),
  });
  const type = form.values.type;
  const secretLabel = provider ? "Replace secret (optional)" : "Secret";

  return (
    <form onSubmit={form.onSubmit(onSave)}>
      <Stack gap="sm">
        <TextInput
          label="Provider name"
          required
          {...form.getInputProps("name")}
        />
        <Select
          label="Protocol"
          data={typeOptions}
          disabled={Boolean(provider)}
          {...form.getInputProps("type")}
        />
        {type === "oidc" && (
          <>
            <TextInput
              label="Issuer URL"
              required
              {...form.getInputProps("oidcIssuer")}
            />
            <TextInput
              label="Client ID"
              required
              {...form.getInputProps("oidcClientId")}
            />
            <PasswordInput
              label={secretLabel}
              placeholder={
                provider ? "Leave blank to keep configured secret" : undefined
              }
              required={!provider}
              autoComplete="new-password"
              {...form.getInputProps("oidcClientSecret")}
            />
          </>
        )}
        {type === "saml" && (
          <>
            <TextInput
              label="Identity provider metadata URL"
              required
              {...form.getInputProps("samlUrl")}
            />
            <Textarea
              label={secretLabel}
              placeholder={
                provider
                  ? "Leave blank to keep configured certificate"
                  : undefined
              }
              required={!provider}
              autosize
              minRows={3}
              {...form.getInputProps("samlCertificate")}
            />
          </>
        )}
        {type === "ldap" && (
          <>
            <TextInput
              label="Server URL"
              required
              {...form.getInputProps("ldapUrl")}
            />
            <TextInput
              label="Bind DN"
              required
              {...form.getInputProps("ldapBindDn")}
            />
            <PasswordInput
              label={secretLabel}
              placeholder={
                provider ? "Leave blank to keep configured password" : undefined
              }
              required={!provider}
              autoComplete="new-password"
              {...form.getInputProps("ldapBindPassword")}
            />
            <TextInput
              label="Base DN"
              required
              {...form.getInputProps("ldapBaseDn")}
            />
            <TextInput
              label="User search filter"
              required
              {...form.getInputProps("ldapUserSearchFilter")}
            />
            <TextInput
              label="Email attribute"
              description="LDAP attribute containing the user's email address."
              {...form.getInputProps("ldapUserAttributes.email")}
            />
            <TextInput
              label="Name attribute"
              description="LDAP attribute containing the user's display name."
              {...form.getInputProps("ldapUserAttributes.name")}
            />
            <TextInput
              label="Verified email attribute"
              description="LDAP attribute that must equal true or 1 before its email can link, update, or sign up."
              {...form.getInputProps("ldapUserAttributes.emailVerified")}
            />
            <Checkbox
              label="Use TLS"
              {...form.getInputProps("ldapTlsEnabled", { type: "checkbox" })}
            />
            {form.values.ldapTlsEnabled && (
              <Textarea
                label="CA certificate (optional)"
                autosize
                minRows={3}
                {...form.getInputProps("ldapTlsCaCert")}
              />
            )}
          </>
        )}
        <Switch
          label="Enable this provider"
          {...form.getInputProps("isEnabled", { type: "checkbox" })}
        />
        <Switch
          label="Allow sign-up for verified identities"
          {...form.getInputProps("allowSignup", { type: "checkbox" })}
        />
        <TextInput
          label="Allowed email domains"
          description="Optional comma or semicolon-separated exact domains allowed to link or sign up. Leave empty to allow all domains."
          {...form.getInputProps("settings.allowedDomains")}
        />
        {type === "saml" && (
          <TextInput
            label="Verified email attribute"
            description="SAML assertion attribute that must equal true or 1 before its email can link, update, or sign up."
            {...form.getInputProps("settings.emailVerifiedAttribute")}
          />
        )}
        <Switch
          label="Synchronize groups during sign-in"
          {...form.getInputProps("groupSync", { type: "checkbox" })}
        />
        {form.values.groupSync && type !== "ldap" && (
          <TextInput
            label="Group claim"
            description="Identity-provider claim containing a string array of group IDs."
            {...form.getInputProps("settings.groupClaim")}
          />
        )}
        {form.values.groupSync && type === "ldap" && (
          <TextInput
            label="Group attribute"
            description="LDAP attribute containing a string array of group IDs."
            {...form.getInputProps("settings.groupAttribute")}
          />
        )}
        <Group justify="flex-end">
          {onCancel && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={loading}>
            {provider ? "Save provider" : "Add provider"}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
