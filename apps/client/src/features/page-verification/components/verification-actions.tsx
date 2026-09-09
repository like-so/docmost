import { Badge, Button, Group } from "@mantine/core";

type Props = {
  status?: string | null;
  onVerify: () => void;
  onReject: () => void;
  onAcknowledge: () => void;
};
export function VerificationActions({
  status,
  onVerify,
  onReject,
  onAcknowledge,
}: Props) {
  const color =
    status === "verified" ? "green" : status === "rejected" ? "red" : "yellow";

  return (
    <Group data-verification-status={status ?? "none"}>
      <Badge color={color}>{status ?? "unverified"}</Badge>
      <Button variant="default" onClick={onAcknowledge}>
        Mark read
      </Button>
      <Button onClick={onVerify}>Verify</Button>
      <Button variant="outline" onClick={onReject}>
        Reject
      </Button>
    </Group>
  );
}
