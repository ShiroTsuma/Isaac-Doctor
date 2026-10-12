import type { OverheadSample } from './types.ts';
export function overheadEstimate(samples: OverheadSample[]) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.time <= first.time) {
    return null;
  }
  const calls = last.calls - first.calls;
  const count = last.samples - first.samples;
  const wrapper = last.wrapperMs - first.wrapperMs;
  const observer = last.observerMs - first.observerMs;
  if (calls < 0 || count < 0 || wrapper < 0 || observer < 0) {
    return null;
  }
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
