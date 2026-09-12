import { Badge, Button, Group, Menu, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  acknowledgePageRead,
  listPageVerifications,
  rejectPage,
  requestVerification,
  verifyPage,
} from "@/features/page-verification/services/page-verification-service.ts";

export function PageVerificationMenuItem({
  onClick,
}: {
  pageId?: string;
  onClick: () => void;
}) {
  return <Menu.Item onClick={onClick}>Request verification</Menu.Item>;
}

export function PageVerificationModal({
  pageId,
  opened,
  onClose,
}: {
  pageId?: string;
  opened: boolean;
  onClose: () => void;
}) {
  const [verifiers, setVerifiers] = useState("");

  async function submit() {
    if (!pageId) return;
    await requestVerification(
      pageId,
      verifiers.split(",").map((value) => value.trim()).filter(Boolean),
    );
    onClose();
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Request verification">
      <Stack>
        <TextInput
          label="Verifier user IDs"
          value={verifiers}
          onChange={(event) => setVerifiers(event.currentTarget.value)}
        />
        <Button disabled={!verifiers.trim() || !pageId} onClick={() => void submit()}>
          Request verification
        </Button>
      </Stack>
    </Modal>
  );
}

export function PageVerificationBadge({ pageId }: { pageId: string }) {
  const [busy, setBusy] = useState(false);
  const { data = [], refetch } = useQuery({
    queryKey: ["page-verifications", pageId],
    queryFn: listPageVerifications,
  });
  const verification = data.find((item) => item.pageId === pageId);
  if (!verification) return null;
  const expiresAt = verification.expiresAt
    ? new Date(verification.expiresAt).toLocaleDateString()
    : null;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refetch();
    } finally {
      setBusy(false);
    }
  };
  const color =
    verification.status === "verified"
      ? "green"
      : verification.status === "rejected"
        ? "red"
        : "yellow";
  return (
    <Group gap="xs" data-verification-status={verification.status}>
      <Badge color={color}>{verification.status}</Badge>
      {expiresAt && <Text size="xs">Expires {expiresAt}</Text>}
      <Button
        size="compact-xs"
        variant="subtle"
        disabled={busy}
        onClick={() => void act(() => acknowledgePageRead(pageId))}
      >
        Mark read
      </Button>
      {verification.status === "requested" && verification.canVerify && (
        <>
          <Button
            size="compact-xs"
            disabled={busy}
            onClick={() => void act(() => verifyPage(verification.id))}
          >
            Verify
          </Button>
          <Button
            size="compact-xs"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => rejectPage(verification.id))}
          >
            Reject
          </Button>
        </>
      )}
    </Group>
  );
}
