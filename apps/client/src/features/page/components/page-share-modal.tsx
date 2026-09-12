import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import api from "@/lib/api-client";
import { extractPageSlugId } from "@/lib";
import ShareModal from "@/features/share/components/share-modal";

type Grant = {
  id: string;
  name: string;
  role: "reader" | "writer";
  type: "user" | "group";
};

type PermissionData = {
  accessLevel: "restricted" | "inherited";
  members: { items?: Grant[] } | Grant[];
};

type GrantInput = {
  userId?: string;
  groupId?: string;
  role: Grant["role"];
};

interface PageShareModalProps {
  readOnly?: boolean;
}

export function PageShareModal({ readOnly = false }: PageShareModalProps) {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const pageId = extractPageSlugId(pageSlug);
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [memberId, setMemberId] = useState("");
  const [memberType, setMemberType] = useState<Grant["type"]>("user");
  const [role, setRole] = useState<Grant["role"]>("reader");
  const permissions = useQuery({
    queryKey: ["page-permissions", pageId],
    queryFn: async () =>
      (await api.post<PermissionData>("/page-permissions/", { pageId, limit: 100 }))
        .data,
    enabled: opened && !!pageId,
  });
  const update = useMutation({
    mutationFn: async (body: { inherit?: boolean; members?: GrantInput[] }) =>
      api.post("/page-permissions/update", { pageId, ...body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["page-permissions", pageId] });
      queryClient.invalidateQueries({ queryKey: ["page", pageId] });
    },
  });
  const members = Array.isArray(permissions.data?.members)
    ? permissions.data.members
    : (permissions.data?.members.items ?? []);

  const saveMembers = (next: Grant[]) => {
    update.mutate({
      members: next.map((member) => ({
        [member.type === "user" ? "userId" : "groupId"]: member.id,
        role: member.role,
      })),
    });
  };

  const addMember = () => {
    if (!memberId.trim()) return;
    saveMembers([
      ...members,
      { id: memberId.trim(), name: memberId.trim(), type: memberType, role },
    ]);
    setMemberId("");
  };

  return (
    <>
      <Group gap={0} wrap="nowrap">
        <ShareModal readOnly={readOnly} />
        {!readOnly && (
          <ActionIcon
            aria-label={t("Manage page access")}
            variant="subtle"
            color="dark"
            onClick={() => setOpened(true)}
          >
            <IconUsers size={18} />
          </ActionIcon>
        )}
      </Group>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t("Page access")}>
        <Stack>
          <Switch
            checked={permissions.data?.accessLevel === "inherited"}
            label={t("Inherit access from the parent page")}
            onChange={(event) => update.mutate({ inherit: event.currentTarget.checked })}
          />
          {permissions.data?.accessLevel === "restricted" && (
            <>
              {members.map((member) => (
                <Group key={`${member.type}-${member.id}`} justify="space-between">
                  <Text size="sm">{member.name}</Text>
                  <Group gap="xs">
                    <Select
                      aria-label={t("Permission role")}
                      data={["reader", "writer"]}
                      value={member.role}
                      onChange={(value) =>
                        saveMembers(
                          members.map((item) =>
                            item === member ? { ...item, role: value as Grant["role"] } : item,
                          ),
                        )
                      }
                    />
                    <Button size="xs" variant="subtle" color="red" onClick={() => saveMembers(members.filter((item) => item !== member))}>
                      {t("Remove")}
                    </Button>
                  </Group>
                </Group>
              ))}
              <TextInput label={t("Member ID")} value={memberId} onChange={(event) => setMemberId(event.currentTarget.value)} />
              <Group grow>
                <Select label={t("Member type")} data={["user", "group"]} value={memberType} onChange={(value) => setMemberType(value as Grant["type"])} />
                <Select label={t("Permission role")} data={["reader", "writer"]} value={role} onChange={(value) => setRole(value as Grant["role"])} />
              </Group>
              <Button onClick={addMember} loading={update.isPending}>{t("Add member")}</Button>
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}
