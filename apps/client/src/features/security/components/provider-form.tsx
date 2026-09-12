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
  PreparedProvider,
} from "@/features/security/types/security.types.ts";

import { useTranslation } from "react-i18next";
import { ProviderConnectionDetails } from "./provider-connection-details";

interface ProviderFormProps {
  preparedProvider?: PreparedProvider;
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

function getInitialValues(provider?: AuthProvider, preparedProvider?: PreparedProvider): ProviderInput {
  return {
    preparedId: provider ? undefined : preparedProvider?.id,
    name: provider?.name ?? "",
    type: provider?.type ?? "oidc",
    isEnabled: provider?.isEnabled ?? true,
    allowSignup: provider?.allowSignup ?? false,
    groupSync: provider?.groupSync ?? false,
    oidcIssuer: provider?.oidcIssuer ?? undefined,
    oidcClientId: provider?.oidcClientId ?? undefined,
    samlUrl: provider?.samlUrl ?? undefined,
    samlEntityId: provider?.samlEntityId ?? undefined,
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
  preparedProvider,
  loading,
  onCancel,
  onSave,
}: ProviderFormProps) {
  const { t } = useTranslation();
  const form = useForm<ProviderInput>({
    initialValues: getInitialValues(provider, preparedProvider),
  });
  const textInputProps = (path: string) => {
    const props = form.getInputProps(path);
    return { ...props, value: props.value ?? "" };
  };
  const type = form.values.type;
  const secretLabel = provider ? "Replace secret (optional)" : "Secret";

  return (
    <form onSubmit={form.onSubmit(onSave)}>
      <Stack gap="sm">
        <TextInput
          label="Provider name"
          required
          {...textInputProps("name")}
        />
        <Select
          label="Protocol"
          data={typeOptions}
          disabled={Boolean(provider)}
          {...textInputProps("type")}
        />
        <ProviderConnectionDetails
          type={type}
          connectionInfo={provider?.connectionInfo ?? preparedProvider?.connectionInfo}
        />
        {type === "oidc" && (
          <>
            <TextInput
              label="Issuer URL"
              required
              {...textInputProps("oidcIssuer")}
            />
            <TextInput
              label="Client ID"
              required
              {...textInputProps("oidcClientId")}
            />
            <PasswordInput
              label={secretLabel}
              placeholder={
                provider ? "Leave blank to keep configured secret" : undefined
              }
              required={!provider}
              autoComplete="new-password"
              {...textInputProps("oidcClientSecret")}
            />
          </>
        )}
        {type === "saml" && (
          <>
            <TextInput
              label={t("IdP login URL")}
              required
              {...textInputProps("samlUrl")}
            />
            <TextInput
              label="Expected IdP Entity ID"
              required
              {...textInputProps("samlEntityId")}
            />
            <Textarea
              label={provider ? t("Replace certificate (optional)") : t("IdP certificate")}
              placeholder={
                provider
                  ? "Leave blank to keep configured certificate"
                  : undefined
              }
              required={!provider}
              autosize
              minRows={3}
              {...textInputProps("samlCertificate")}
            />
          </>
        )}
        {type === "ldap" && (
          <>
            <TextInput
              label="Server URL"
              required
              {...textInputProps("ldapUrl")}
            />
            <TextInput
              label="Bind DN"
              required
              {...textInputProps("ldapBindDn")}
            />
            <PasswordInput
              label={secretLabel}
              placeholder={
                provider ? "Leave blank to keep configured password" : undefined
              }
              required={!provider}
              autoComplete="new-password"
              {...textInputProps("ldapBindPassword")}
            />
            <TextInput
              label="Base DN"
              required
              {...textInputProps("ldapBaseDn")}
            />
            <TextInput
              label="User search filter"
              description="Use {{username}} exactly; its value is escaped before LDAP search."
              placeholder="(uid={{username}})"
              required
              {...textInputProps("ldapUserSearchFilter")}
            />
            <TextInput
              label="Email attribute"
              description="LDAP attribute containing the user's email address."
              {...textInputProps("ldapUserAttributes.email")}
            />
            <TextInput
              label="Name attribute"
              description="LDAP attribute containing the user's display name."
              {...textInputProps("ldapUserAttributes.name")}
            />
            <TextInput
              label="Verified email attribute"
              description="LDAP attribute that must equal true or 1 before its email can link, update, or sign up."
              {...textInputProps("ldapUserAttributes.emailVerified")}
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
                {...textInputProps("ldapTlsCaCert")}
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
          {...textInputProps("settings.allowedDomains")}
        />
        {type === "saml" && (
          <TextInput
            label="Verified email attribute"
            description="SAML assertion attribute that must equal true or 1 before its email can link, update, or sign up."
            {...textInputProps("settings.emailVerifiedAttribute")}
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
            {...textInputProps("settings.groupClaim")}
          />
        )}
        {form.values.groupSync && type === "ldap" && (
          <TextInput
            label="Group attribute"
            description="LDAP attribute containing a string array of group IDs."
            {...textInputProps("settings.groupAttribute")}
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
