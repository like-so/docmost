import { RagEvidence, toInputRevision } from '../contracts';
import { applyRerankStage } from './rerank';

const evidence = (text: string, baseScore: number): RagEvidence => ({
  chunkId: `chunk-${text}`,
  key: { workspaceId: 'ws', pageId: `page-${text}` },
  inputRevision: toInputRevision('1'),
  text,
  locator: {
    pageId: `page-${text}`,
    headingPath: [],
    start: 0,
    end: text.length,
    offsetUnit: 'utf16',
    textHash: `hash-${text}`,
  },
  score: { kind: 'rrf', value: baseScore },
});

describe('applyRerankStage', () => {
  it('selects MMR over the composite score, not the pre-rerank retrieval score', () => {
    // Candidate A wins retrieval (1 vs 0.1) but loses the model call
    // (0.2 vs 1): the composite (0.6*model + 0.3*base + 0.1) ranks B first
    // (0.73 vs 0.52), and MMR must follow the composite.
    const candidates = [
      evidence('unique alpha tokens', 1),
      evidence('entirely different beta wording', 0.1),
    ];
    const result = applyRerankStage({
      candidates,
      modelScores: [0.2, 1],
      threshold: 0.2,
      topK: 2,
      explicitScope: false,
    });
    expect(result.outcome).toBe('ok');
    expect(result.evidence.map((item) => item.text)).toEqual([
      'entirely different beta wording',
      'unique alpha tokens',
    ]);
    expect(result.evidence[0].score).toEqual({
      kind: 'rerank',
      value: expect.closeTo(0.73, 8),
    });
    expect(result.evidence[1].score).toEqual({
      kind: 'rerank',
      value: expect.closeTo(0.52, 8),
    });
  });

  it('keeps the top-1 fallback for an explicitly scoped search regardless of score', () => {
    // rerank.go pins FallbackMinScore to -Inf for explicit scopes: even a
    // model score below the unscoped 0.15 floor must not erase the scope.
    const candidates = [
      evidence('scoped alpha', 0.8),
      evidence('scoped beta', 0.2),
    ];
    const scoped = applyRerankStage({
      candidates,
      modelScores: [0.1, 0.05],
      threshold: 0.9,
      topK: 5,
      explicitScope: true,
    });
    expect(scoped.outcome).toBe('fallback_top1');
    expect(scoped.evidence.map((item) => item.text)).toEqual(['scoped alpha']);

    // The same scores without an explicit scope fall below the 0.15 fallback
    // floor: nothing survives.
    const unscoped = applyRerankStage({
      candidates,
      modelScores: [0.1, 0.05],
      threshold: 0.9,
      topK: 5,
      explicitScope: false,
    });
    expect(unscoped.outcome).toBe('all_below_threshold');
    expect(unscoped.evidence).toEqual([]);
  });

  it('preserves retrieval order when model scores are unavailable or misaligned', () => {
    const candidates = [
      evidence('first text', 1),
      evidence('second text', 0.5),
    ];
    const unavailable = applyRerankStage({
      candidates,
      modelScores: null,
      threshold: 0.2,
      topK: 2,
      explicitScope: false,
    });
    expect(unavailable.outcome).toBe('model_unavailable');
    expect(unavailable.evidence.map((item) => item.text)).toEqual([
      'first text',
      'second text',
    ]);
    expect(unavailable.evidence[0].score.kind).toBe('rrf');

    const misaligned = applyRerankStage({
      candidates,
      modelScores: [0.9],
      threshold: 0.2,
      topK: 2,
      explicitScope: false,
    });
    expect(misaligned.outcome).toBe('model_unavailable');
    expect(misaligned.evidence).toHaveLength(2);
  });
});
