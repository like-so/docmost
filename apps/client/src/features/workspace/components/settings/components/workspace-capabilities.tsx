import { Group, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtom } from "jotai";
import { queryClient } from "@/main.tsx";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { IWorkspace } from "@/features/workspace/types/workspace.types.ts";

type Setting = "templates" | "spaces";

type Props = {
  setting: Setting;
  title: string;
  description: string;
};

function capabilityValue(
  workspace: IWorkspace | null,
  setting: Setting,
): boolean {
  if (setting === "templates") {
    return workspace?.settings?.templates?.allowMemberTemplates === true;
  }
  return workspace?.settings?.spaces?.allowPersonal === true;
}

function capabilityInput(setting: Setting, enabled: boolean) {
  return setting === "templates"
    ? { allowMemberTemplates: enabled }
    : { allowPersonalSpaces: enabled };
}

export function WorkspaceCapability({ setting, title, description }: Props) {
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const value = capabilityValue(workspace, setting);

  async function change(enabled: boolean) {
    try {
      const updated = await updateWorkspace(capabilityInput(setting, enabled));
      setWorkspace(updated);
      queryClient.setQueryData(["workspace"], updated);
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
    } catch (error) {
      notifications.show({
        color: "red",
        message: error?.response?.data?.message ?? "Unable to update setting",
      });
    }
  }

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{title}</Text>
        <Text size="sm" c="dimmed">{description}</Text>
      </div>
      <Switch checked={value} onChange={(event) => change(event.currentTarget.checked)} />
    </Group>
  );
}
