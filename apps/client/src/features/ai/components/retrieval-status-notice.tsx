import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type {
  RagRetrievalMetadata,
  RagRerankStatus,
} from "../services/ai-service";

const STATUS_NOTICE: Record<RagRerankStatus, string | null> = {
  applied: null,
  not_applicable: null,
  not_configured:
    "Reranking is not configured; results keep the retrieval order.",
  failed: "Reranking failed; results keep the retrieval order.",
};

/**
 * Renders the rerank status actually reported by the executed retrieval
 * stage. A status of "applied" is silent; anything else is a visible notice
 * so fallback results never look reranked.
 */
export function RetrievalStatusNotice({
  retrieval,
}: {
  retrieval: RagRetrievalMetadata | undefined;
}) {
  const { t } = useTranslation();
  if (!retrieval) return null;
  const message = STATUS_NOTICE[retrieval.rerankStatus];
  if (!message) return null;
  return (
    <Text
      size="xs"
      c={retrieval.rerankStatus === "failed" ? "yellow" : "dimmed"}
      role="status"
    >
      {t(message)}
    </Text>
  );
}
