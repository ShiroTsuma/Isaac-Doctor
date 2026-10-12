import type { slowFrameComparisons } from './slow-frames.ts';

type Comparisons = ReturnType<typeof slowFrameComparisons>;

export function slowFrameGuidance(matched: Comparisons, partial: boolean) {
  const wall = matched.mean_extra_wall_ms;
  const self = matched.mean_extra_callback_self_ms;
  const remaining = matched.mean_extra_unattributed_wall_ms;
  let status = 'mixed';
  let title = 'Both measured callbacks and other wall time increased';
  let next =
    'Inspect a slow interval and its largest callback increases, then compare its Presentation timings.';
  if (partial || matched.boundary_crossing_calls) {
    status = 'partial';
    title = 'The recording cannot reliably separate the extra costs';
    next =
      'Select a wider range or record with callback timings and timeline enabled, without mod/hook exclusions or a minimum capture duration filter. Check dropped events before comparing costs.';
  } else if (matched.matched_intervals < 3 || wall === null || self === null) {
    status = 'insufficient';
    title = 'Too few comparable intervals to identify a recurring pattern';
    next =
      'Select a longer stable-room range. Keep startup and menu transitions separate; inspect an individual interval only as a lead.';
  } else if (wall <= 0.1) {
    status = 'little-extra';
    title = 'The slow tail is close to its matched references';
    next =
      'Check the frame pacing summary below. A consistently expensive update phase needs a different comparison from an isolated spike; inspect its absolute callback costs in Bottom-up.';
  } else if (self >= wall * 0.6 && remaining !== null && remaining >= 0) {
    status = 'callbacks';
    title = 'Higher callback self accompanies most of the extra wall time';
    next =
      'Open evidence for a recurring callback below. Compare call count and cost per call, inspect its source, then measure the same scene after a targeted change.';
  } else if (remaining !== null && remaining >= wall * 0.6) {
    status = 'outside';
    title = 'Measured callbacks do not account for most of the extra wall time';
    next =
      'Open Presentation to check swap and screenshot spans. Record the same room with Presentation and frame intervals enabled but callback timings/timeline disabled. This compares measurement modes without disabling mods.';
  } else if (self > wall || (remaining !== null && remaining < 0)) {
    status = 'redistributed';
    title = 'Callback increases are offset by lower wall time elsewhere';
    next =
      'Inspect individual differences before selecting a mod to change. Increased callback self alone does not explain the net slowdown.';
  }
  return {
    status,
    title,
    next,
    evidence:
      wall === null || self === null || remaining === null
        ? 'No matched wall/self difference is available.'
        : `Compared slow intervals average ${wall.toFixed(2)} ms extra wall: ${self.toFixed(2)} ms extra measured callback self and ${remaining.toFixed(2)} ms extra unattributed wall.`,
    limit:
      'This describes observed differences, not a cause. Callback self includes native API work and waiting. Unattributed wall is not measured engine, GPU or GC time. The 60% split is a reading aid, not a significance test.',
  };
}

export function framePacing(
  frames: {
    start: number;
    duration: number;
    thread: number;
    update: boolean;
  }[],
  render: boolean,
) {
  const withUpdate = frames.filter((f) => f.update);
  const withoutUpdate = frames.filter((f) => !f.update);
  const mean = (rows: typeof frames) =>
    rows.length
      ? rows.reduce((sum, f) => sum + f.duration, 0) / rows.length
      : null;
  let adjacent = 0;
  let alternating = 0;
  let pairTotal = 0;
  const ordered = [...frames].sort(
    (a, b) => a.thread - b.thread || a.start - b.start,
  );
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    if (
      a.thread === b.thread &&
      Math.abs(a.start + a.duration - b.start) < 0.0001
    ) {
      adjacent++;
      pairTotal += a.duration + b.duration;
      if (a.update !== b.update) {
        alternating++;
      }
    }
  }
  const updateMean = mean(withUpdate);
  const renderOnlyMean = mean(withoutUpdate);
  return {
    available: render && withUpdate.length > 0 && withoutUpdate.length > 0,
    with_update_count: withUpdate.length,
    without_update_count: withoutUpdate.length,
    with_update_mean_ms: updateMean,
    without_update_mean_ms: renderOnlyMean,
    adjacent_pairs: adjacent,
    alternating_pairs: alternating,
    mean_pair_ms: adjacent ? pairTotal / adjacent : null,
    alternating_update_pattern:
      render &&
      withUpdate.length >= 20 &&
      withoutUpdate.length >= 20 &&
      adjacent >= 39 &&
      alternating / adjacent >= 0.9 &&
      updateMean !== null &&
      renderOnlyMean !== null &&
      updateMean - renderOnlyMean >= 1,
  };
}
