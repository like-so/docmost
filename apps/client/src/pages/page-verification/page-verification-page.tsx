import {
  Alert,
  Button,
  Card,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { VerificationActions } from "@/features/page-verification/components/verification-actions";
import {
  acknowledgePageRead,
  listPageVerifications,
  rejectPage,
  requestVerification,
  verifyPage,
} from "@/features/page-verification/services/page-verification-service";

export default function PageVerificationPage() {
  const client = useQueryClient();
  const verifications = useQuery({
    queryKey: ["page-verifications"],
    queryFn: listPageVerifications,
  });
  const [pageId, setPageId] = useState("");
  const [verifierIds, setVerifierIds] = useState("");
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["page-verifications"] });
  const request = useMutation({
    mutationFn: () =>
      requestVerification(
        pageId,
        verifierIds
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      setPageId("");
      setVerifierIds("");
      void refresh();
    },
  });
  const verify = useMutation({
    mutationFn: verifyPage,
    onSuccess: () => void refresh(),
  });
  const reject = useMutation({
    mutationFn: (verificationId: string) => rejectPage(verificationId),
    onSuccess: () => void refresh(),
  });
  const acknowledge = useMutation({ mutationFn: acknowledgePageRead });

  return (
    <Stack maw={760} mx="auto" p="md">
      <Title order={1}>Page verification</Title>
      <Card withBorder>
        <Stack>
          <TextInput
            label="Page ID"
            value={pageId}
            onChange={(event) => setPageId(event.currentTarget.value)}
          />
          <TextInput
            label="Verifier user IDs"
            description="Separate IDs with commas."
            value={verifierIds}
            onChange={(event) => setVerifierIds(event.currentTarget.value)}
          />
          <Button
            disabled={!pageId || !verifierIds || request.isPending}
            onClick={() => request.mutate()}
          >
            Request verification
          </Button>
        </Stack>
      </Card>
      {verifications.isError && (
        <Alert color="red">Unable to load page verifications.</Alert>
      )}
      {verifications.data?.map((verification) => (
        <Card key={verification.id} withBorder>
          <Stack>
            <Text fw={600}>Page {verification.pageId}</Text>
            <VerificationActions
              status={verification.status}
              onAcknowledge={() => acknowledge.mutate(verification.pageId)}
              onVerify={() => verify.mutate(verification.id)}
              onReject={() => reject.mutate(verification.id)}
            />
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
