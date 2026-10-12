import type { OverheadSample } from './types.ts';
export function overheadEstimate(samples: OverheadSample[]) {
  const first = samples[0],
    last = samples.at(-1);
  if (!first || !last || last.time <= first.time) return null;
  const calls = last.calls - first.calls,
    count = last.samples - first.samples,
    wrapper = last.wrapperMs - first.wrapperMs,
    observer = last.observerMs - first.observerMs;
  if (calls < 0 || count < 0 || wrapper < 0 || observer < 0) return null;
  return {
    calls,
    samples: count,
    wrapperMs: count ? (wrapper / count) * calls : null,
    observerMs: observer,
    spanMs: last.time - first.time,
    auxiliaryDropped: last.auxiliaryDropped,
    contextFailures: last.contextFailures,
    errorsOmitted: last.errorsOmitted,
  };
}
