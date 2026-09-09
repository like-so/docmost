import { Text, Divider, Group, Switch, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { ISpace } from "@/features/space/types/space.types.ts";
import { updateSpace } from "@/features/space/services/space-service.ts";

type SpaceSecuritySettingsProps = {
  space: ISpace;
  readOnly?: boolean;
};

export default function SpaceSecuritySettings({
  space,
  readOnly,
}: SpaceSecuritySettingsProps) {
  const { t } = useTranslation();

  if (readOnly) return null;

  return (
    <div>
      <Title order={3} my="md" size="h6" fw={600}>
        {t("Security")}
      </Title>

      <SecurityToggle
        space={space}
        field="disablePublicSharing"
        label={t("Allow public sharing")}
        checked={space.settings?.sharing?.disabled !== true}
      />

      <Divider my="lg" />

      <SecurityToggle
        space={space}
        field="allowViewerComments"
        label={t("Allow viewer comments")}
        checked={space.settings?.comments?.allowViewerComments === true}
      />
    </div>
  );
}

function SecurityToggle({
  space,
  field,
  label,
  checked,
}: {
  space: ISpace;
  field: "disablePublicSharing" | "allowViewerComments";
  label: string;
  checked: boolean;
}) {
  async function change(value: boolean) {
    try {
      await updateSpace({
        id: space.id,
        [field]: field === "disablePublicSharing" ? !value : value,
      });
    } catch (error) {
      notifications.show({
        color: "red",
        message: error?.response?.data?.message ?? "Unable to update setting",
      });
    }
  }

  return (
    <Group justify="space-between">
      <Text>{label}</Text>
      <Switch checked={checked} onChange={(event) => change(event.currentTarget.checked)} />
    </Group>
  );
}
