import { Spotlight } from "@mantine/spotlight";
import { IconAdjustments, IconSearch, IconSparkles } from "@tabler/icons-react";
import {
  Group,
  Button,
  VisuallyHidden,
  Text,
  SegmentedControl,
  Stack,
  NumberInput,
  Slider,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { useDebouncedValue } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { searchSpotlightStore } from "../constants.ts";
import { SearchSpotlightFilters } from "./search-spotlight-filters.tsx";
import { useUnifiedSearch } from "../hooks/use-unified-search.ts";
import { SearchResultItem } from "./search-result-item.tsx";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import {
  semanticSearch,
  type RagRetrievalMode,
  type RagRetrievalOverride,
} from "@/features/ai/services/ai-service";
import { RetrievalStatusNotice } from "@/features/ai/components/retrieval-status-notice";

interface SearchSpotlightProps {
  spaceId?: string;
}
export function SearchSpotlight({ spaceId }: SearchSpotlightProps) {
  const workspace = useAtomValue(workspaceAtom);
  const { t } = useTranslation();
  const hasAiFeature = workspace?.settings?.ai?.search === true;
  const [query, setQuery] = useState("");
  const [debouncedSearchQuery] = useDebouncedValue(query, 300);
  const [filters, setFilters] = useState<{
    spaceId?: string | null;
    contentType?: string;
    creatorId?: string | null;
    labelIds?: string[];
    titleOnly?: boolean;
  }>({
    contentType: "page",
  });
  const [isAiMode, setIsAiMode] = useState(false);
  const [aiSearchMode, setAiSearchMode] = useState<RagRetrievalMode>("hybrid");
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [overrideForm, setOverrideForm] = useState<{
    recallCount: number | null;
    vectorThreshold: number | null;
    keywordThreshold: number | null;
    rerankModelText: string;
    rerankTopK: number | null;
    rerankThreshold: number | null;
  }>({
    recallCount: null,
    vectorThreshold: null,
    keywordThreshold: null,
    rerankModelText: "",
    rerankTopK: null,
    rerankThreshold: null,
  });

  // Build unified search params
  const searchParams = useMemo(() => {
    const params: any = {
      query: debouncedSearchQuery,
      contentType: filters.contentType || "page", // Only used for frontend routing
    };

    // Handle space filtering - only pass spaceId if a specific space is selected
    if (filters.spaceId) {
      params.spaceId = filters.spaceId;
    }

    if (filters.creatorId) {
      params.creatorId = filters.creatorId;
    }

    if (filters.labelIds?.length) {
      params.labelIds = filters.labelIds;
    }

    if (filters.titleOnly) {
      params.titleOnly = true;
    }

    return params;
  }, [debouncedSearchQuery, filters]);

  const { data: searchResults, isFetching } = useUnifiedSearch(
    searchParams,
    !isAiMode, // Disable regular search when in AI mode
  );
  const [aiSearchResult, setAiSearchResult] = useState<any>();
  const [isAiLoading, setAiLoading] = useState(false);
  const [aiSearchError, setAiSearchError] = useState<Error>();
  const aiRequestId = useRef(0);

  // Any change to query, mode, or filters must discard in-flight and settled
  // AI results so stale answers never render under new controls.
  const invalidateAiResults = useCallback(() => {
    aiRequestId.current += 1;
    setAiSearchResult(undefined);
    setAiSearchError(undefined);
    setAiLoading(false);
  }, []);

  const handleQueryChange = (nextQuery: string) => {
    if (nextQuery === query) return;
    invalidateAiResults();
    setQuery(nextQuery);
  };

  const handleAiModeChange = (nextMode: string) => {
    if (nextMode === aiSearchMode) return;
    invalidateAiResults();
    setAiSearchMode(nextMode as RagRetrievalMode);
  };

  const overridePayload = useCallback((): RagRetrievalOverride | undefined => {
    const payload: RagRetrievalOverride = {};
    if (overrideForm.recallCount != null)
      payload.recallCount = overrideForm.recallCount;
    if (overrideForm.vectorThreshold != null)
      payload.vectorThreshold = overrideForm.vectorThreshold;
    if (overrideForm.keywordThreshold != null)
      payload.keywordThreshold = overrideForm.keywordThreshold;
    if (overrideForm.rerankModelText.trim())
      payload.rerankModel = overrideForm.rerankModelText.trim();
    if (overrideForm.rerankTopK != null)
      payload.rerankTopK = overrideForm.rerankTopK;
    if (overrideForm.rerankThreshold != null)
      payload.rerankThreshold = overrideForm.rerankThreshold;
    return Object.keys(payload).length > 0 ? payload : undefined;
  }, [overrideForm]);

  // Show error notification when AI search fails
  useEffect(() => {
    if (aiSearchError) {
      notifications.show({
        message:
          aiSearchError.message || t("AI search failed. Please try again."),
        color: "red",
        position: "top-center",
      });
    }
  }, [aiSearchError, t]);

  const isFilterBrowse =
    (filters.labelIds?.length ?? 0) > 0 || !!filters.creatorId;
  // while the debounce is pending the empty list is not a settled "no results"
  const isQuerySettled = query === debouncedSearchQuery;

  // Determine result type for rendering
  const isAttachmentSearch = filters.contentType === "attachment";

  const resultItems = (searchResults || []).map((result) => (
    <SearchResultItem
      key={result.id}
      result={result}
      isAttachmentResult={isAttachmentSearch}
      showSpace={!filters.spaceId}
    />
  ));

  const handleFiltersChange = useCallback(
    (newFilters: any) => {
      setFilters(newFilters);
      invalidateAiResults();
    },
    [invalidateAiResults],
  );

  const handleAskClick = () => {
    setIsAiMode(!isAiMode);
  };

  const handleAiSearchTrigger = () => {
    if (query.trim() && isAiMode) {
      const requestId = ++aiRequestId.current;
      setAiLoading(true);
      semanticSearch(query, filters.spaceId || undefined, {
        mode: aiSearchMode,
        retrieval: overridePayload(),
      })
        .then((result) => {
          if (aiRequestId.current === requestId) setAiSearchResult(result);
        })
        .catch(() => {
          if (aiRequestId.current === requestId) {
            setAiSearchError(new Error("AI search failed"));
          }
        })
        .finally(() => {
          if (aiRequestId.current === requestId) setAiLoading(false);
        });
    }
  };

  return (
    <>
      <Spotlight.Root
        size="xl"
        maxHeight={600}
        store={searchSpotlightStore}
        query={query}
        onQueryChange={handleQueryChange}
        scrollable
        overlayProps={{
          backgroundOpacity: 0.55,
        }}
      >
        <Group gap="xs" px="sm" pt="sm" pb="xs">
          <Spotlight.Search
            placeholder={isAiMode ? t("Ask a question...") : t("Search...")}
            aria-label={isAiMode ? t("Ask a question...") : t("Search")}
            leftSection={<IconSearch size={20} stroke={1.5} />}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                isAiMode &&
                query.trim() &&
                !isAiLoading
              ) {
                e.preventDefault();
                handleAiSearchTrigger();
              }
            }}
          />
          {isAiMode && hasAiFeature && (
            <>
              <SegmentedControl
                size="xs"
                value={aiSearchMode}
                onChange={handleAiModeChange}
                data={[
                  { value: "hybrid", label: t("Hybrid") },
                  { value: "semantic", label: t("Semantic") },
                  { value: "keyword", label: t("Keyword") },
                ]}
              />
              <Tooltip label={t("Retrieval overrides")}>
                <ActionIcon
                  variant={overridesOpen ? "light" : "subtle"}
                  color="gray"
                  aria-label={t("Retrieval overrides")}
                  onClick={() => setOverridesOpen((open) => !open)}
                >
                  <IconAdjustments size={16} />
                </ActionIcon>
              </Tooltip>
              <Button
                size="xs"
                leftSection={<IconSparkles size={16} />}
                onClick={handleAiSearchTrigger}
                disabled={!query.trim()}
                loading={isAiLoading}
              >
                Ask
              </Button>
            </>
          )}
        </Group>

        <div
          style={{
            padding: "4px 16px",
          }}
        >
          <SearchSpotlightFilters
            onFiltersChange={handleFiltersChange}
            onAskClick={handleAskClick}
            spaceId={spaceId}
            isAiMode={isAiMode}
          />
          {isAiMode && hasAiFeature && overridesOpen && (
            <Stack gap="xs" pb="xs">
              <Group gap="xs">
                <Text size="xs" c="dimmed">
                  {t(
                    "Per-search overrides; empty fields use workspace defaults.",
                  )}
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() =>
                    setOverrideForm({
                      recallCount: null,
                      vectorThreshold: null,
                      keywordThreshold: null,
                      rerankModelText: "",
                      rerankTopK: null,
                      rerankThreshold: null,
                    })
                  }
                >
                  {t("Reset")}
                </Button>
              </Group>
              <NumberInput
                label="Recall count"
                description="Overrides the workspace default for this search (1-100)."
                min={1}
                max={100}
                step={1}
                w={220}
                value={overrideForm.recallCount ?? ""}
                onChange={(value) =>
                  setOverrideForm((current) => ({
                    ...current,
                    recallCount: toOptionalInt(value),
                  }))
                }
              />
              <Slider
                label={(value) => `Vector threshold: ${value}`}
                min={0}
                max={1}
                step={0.05}
                w={220}
                value={overrideForm.vectorThreshold ?? 0}
                onChange={(value) =>
                  setOverrideForm((current) => ({
                    ...current,
                    vectorThreshold: value,
                  }))
                }
              />
              <Slider
                label={(value) => `Keyword threshold: ${value}`}
                min={0}
                max={1}
                step={0.05}
                w={220}
                value={overrideForm.keywordThreshold ?? 0}
                onChange={(value) =>
                  setOverrideForm((current) => ({
                    ...current,
                    keywordThreshold: value,
                  }))
                }
              />
              <NumberInput
                label="Rerank top K"
                min={1}
                max={100}
                step={1}
                w={220}
                value={overrideForm.rerankTopK ?? ""}
                onChange={(value) =>
                  setOverrideForm((current) => ({
                    ...current,
                    rerankTopK: toOptionalInt(value),
                  }))
                }
              />
              <Slider
                label={(value) => `Rerank threshold: ${value}`}
                min={-10}
                max={10}
                step={0.1}
                w={220}
                value={overrideForm.rerankThreshold ?? 0}
                onChange={(value) =>
                  setOverrideForm((current) => ({
                    ...current,
                    rerankThreshold: value,
                  }))
                }
              />
            </Stack>
          )}
        </div>

        <VisuallyHidden role="status" aria-live="polite">
          {isAiMode
            ? query.length > 0 && !isAiLoading && !aiSearchResult
              ? t("No answer available")
              : ""
            : (query.length > 0 || isFilterBrowse) && !isFetching
              ? resultItems.length === 0
                ? t("No results found")
                : t("{{count}} results found", { count: resultItems.length })
              : ""}
        </VisuallyHidden>

        <Spotlight.ActionsList>
          {isAiMode ? (
            <>
              {query.length === 0 && (
                <Spotlight.Empty>{t("Ask a question...")}</Spotlight.Empty>
              )}
              {query.length > 0 &&
                (isAiLoading || aiSearchResult) &&
                (isAiLoading ? (
                  <Spotlight.Empty>{t("Searching...")}</Spotlight.Empty>
                ) : (
                  <>
                    <RetrievalStatusNotice
                      retrieval={aiSearchResult?.retrieval}
                    />
                    {aiSearchResult?.items?.map((result: any) => (
                      <SearchResultItem
                        key={result.id}
                        result={result}
                        isAttachmentResult={false}
                        showSpace={!filters.spaceId}
                      />
                    ))}
                  </>
                ))}
              {query.length > 0 && !isAiLoading && !aiSearchResult && (
                <Spotlight.Empty>{t("No answer available")}</Spotlight.Empty>
              )}
            </>
          ) : (
            <>
              {query.length === 0 &&
                !isFilterBrowse &&
                resultItems.length === 0 && (
                  <Spotlight.Empty>
                    {t("Start typing to search...")}
                  </Spotlight.Empty>
                )}

              {(query.length > 0 || isFilterBrowse) &&
                !isFetching &&
                isQuerySettled &&
                resultItems.length === 0 && (
                  <Spotlight.Empty>{t("No results found...")}</Spotlight.Empty>
                )}

              {resultItems.length > 0 && <>{resultItems}</>}

              {(query.length > 0 || isFilterBrowse) &&
                isFetching &&
                resultItems.length === 0 && (
                  <Spotlight.Empty>
                    <Text size="sm" style={{ marginTop: 10 }}>
                      {t("Searching...")}
                    </Text>
                  </Spotlight.Empty>
                )}
            </>
          )}
        </Spotlight.ActionsList>
      </Spotlight.Root>
    </>
  );
}

function toOptionalInt(value: string | number): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
