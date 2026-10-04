// Shared, immutable analysis context for one bounded dataset (profiles are computed once per process).
import type { Dataset } from '../dataset/load.ts';
import type { AnalysisContext } from '../engine/triggers.ts';
import type { FieldGaps } from '../../../shared/plan.ts';
import { profileFields } from '../engine/profile.ts';
import { computeFieldGaps } from '../engine/gaps.ts';
import { runMapping } from '../engine/transforms.ts';

export type EngineContext = AnalysisContext & { gaps: FieldGaps };

const cache = new WeakMap<Dataset, EngineContext>();

export function engineContext(dataset: Dataset): EngineContext {
  let ctx = cache.get(dataset);
  if (!ctx) {
    const profiles = profileFields(dataset.records, dataset.source);
    ctx = {
      source: dataset.source,
      target: dataset.target,
      records: dataset.records,
      profiles,
      run: runMapping,
      gaps: computeFieldGaps(dataset.source, dataset.target, profiles),
    };
    cache.set(dataset, ctx);
  }
  return ctx;
}
