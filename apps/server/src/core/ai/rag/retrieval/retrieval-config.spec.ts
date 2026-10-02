import {
  DEFAULT_RECALL_COUNT,
  RECALL_COUNT_MAX,
  mergeRetrievalOverride,
  parseChatRetrievalSettings,
  parseRetrievalSettings,
} from './retrieval-config';

describe('parseChatRetrievalSettings', () => {
  it('carries independent chat defaults, not the search settings', () => {
    const chat = parseChatRetrievalSettings({
      recallCount: 17,
      rerankModel: 'chat-rerank-model',
      rewriteEnabled: false,
    });
    expect(chat.recallCount).toBe(17);
    expect(chat.rerankModel).toBe('chat-rerank-model');
    expect(chat.rewriteEnabled).toBe(false);
    expect(chat.expansionEnabled).toBe(true);
    // Unset fields fall back to the pinned defaults, never to another
    // flow's stored values.
    expect(chat.rerankTopK).toBe(parseRetrievalSettings({}).rerankTopK);
    expect(chat.recallCount).not.toBe(DEFAULT_RECALL_COUNT);
  });
});

describe('mergeRetrievalOverride', () => {
  const stored = {
    recallCount: 30,
    rerankModel: 'stored-model',
    rerankThreshold: 0.4,
  };

  it('inherits the stored default for an omitted, null, or blank rerankModel', () => {
    for (const overrides of [
      undefined,
      {},
      { rerankModel: null },
      { rerankModel: '   ' },
    ] as const) {
      expect(mergeRetrievalOverride(stored, overrides).rerankModel).toBe(
        'stored-model',
      );
    }
  });

  it('applies only a non-blank explicit rerankModel reference', () => {
    expect(
      mergeRetrievalOverride(stored, { rerankModel: 'override-model' })
        .rerankModel,
    ).toBe('override-model');
  });

  it('overrides plain knobs and clamps out-of-range values', () => {
    const merged = mergeRetrievalOverride(stored, {
      recallCount: RECALL_COUNT_MAX + 500,
      rerankThreshold: -99,
    });
    expect(merged.recallCount).toBe(RECALL_COUNT_MAX);
    expect(merged.rerankThreshold).toBe(-10);
    expect(merged.rerankModel).toBe('stored-model');
  });

  it('returns the pinned defaults without stored settings or overrides', () => {
    const merged = mergeRetrievalOverride(null, undefined);
    expect(merged.recallCount).toBe(DEFAULT_RECALL_COUNT);
    expect(merged.rerankModel).toBeNull();
  });
});
