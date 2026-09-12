import { ActionIcon, CopyButton, Group, Paper, Stack, Text, Textarea, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { AuthProviderKind, ProviderConnectionInfo } from "../types/security.types";

export function ProviderConnectionDetails({ type, connectionInfo }: {
  type: AuthProviderKind;
  connectionInfo?: ProviderConnectionInfo;
}) {
  const { t } = useTranslation();
  if (type === "ldap") return null;
  if (!connectionInfo) return <Text size="sm" c="dimmed">{t("Connection details are unavailable. Reload provider settings to try again.")}</Text>;
  const fields = type === "oidc"
    ? [{ label: t("Callback URL"), value: connectionInfo.oidcCallbackUrl }]
    : [
        { label: t("Entity ID (service provider)"), value: connectionInfo.samlEntityId },
        { label: t("Callback URL (ACS)"), value: connectionInfo.samlAcsUrl },
      ];
  return (
    <Paper withBorder p="sm" mt="sm" radius="sm">
      <Stack gap="xs">
        <Text size="sm" fw={500}>{t("Connection details")}</Text>
        <Text size="xs" c="dimmed">{t("Copy these values into your identity provider. Disabling this provider keeps its configuration and URLs.")}</Text>
        {fields.map(({ label, value }) => (
          <Group key={label} align="flex-end" wrap="nowrap" gap="xs">
            <Textarea
              label={label}
              value={value}
              readOnly
              autosize
              minRows={1}
              maxRows={4}
              style={{ flex: 1, minWidth: 0 }}
              styles={{ input: { fontFamily: "monospace", fontSize: 12, overflowWrap: "anywhere" } }}
            />
            <CopyButton value={value}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? t("Copied") : t("Copy {{field}}", { field: label })}>
                  <ActionIcon type="button" variant="subtle" onClick={copy} aria-label={t("Copy {{field}}", { field: label })} mb={6}>
                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
