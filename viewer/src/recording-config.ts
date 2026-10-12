export const triggerOptions = [
  ['immediate', 'Immediately'],
  ['run-load', 'After run loads'],
  ['room-entry', 'On room entry'],
  ['level-entry', 'On level entry'],
  ['projectile', 'On projectile spawn'],
  ['tear', 'On tear spawn'],
  ['effect', 'On effect spawn'],
  ['npc', 'On NPC spawn'],
  ['damage', 'On damage callback'],
  ['run-end', 'On run end'],
  ['game-exit', 'On game exit'],
  ['duration', 'After duration'],
  ['manual', 'Manual stop'],
] as const;
export type CaptureTrigger = (typeof triggerOptions)[number][0];
export interface RecordingConfig {
  startOn: CaptureTrigger;
  stopOn: CaptureTrigger;
  startDelayMs: number;
  stopDelayMs: number;
  maxDurationMs: number;
}
const defaults: RecordingConfig = {
  startOn: 'run-load',
  stopOn: 'duration',
  startDelayMs: 0,
  stopDelayMs: 0,
  maxDurationMs: 0,
};
export function validDelay(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 3600000;
}
export function effectiveRecordingConfig(config: RecordingConfig): RecordingConfig {
  return {
    ...config,
    startDelayMs: Number.isNaN(config.startDelayMs) ? 0 : config.startDelayMs,
    stopDelayMs:
      config.stopOn === 'manual' || config.stopOn === 'duration' || Number.isNaN(config.stopDelayMs)
        ? 0
        : config.stopDelayMs,
    maxDurationMs: config.stopOn === 'duration' ? 0 : config.maxDurationMs,
  };
}
export function validRecordingConfig(config: RecordingConfig) {
  const value = effectiveRecordingConfig(config);
  return (
    validDelay(value.startDelayMs) &&
    validDelay(value.stopDelayMs) &&
    validDelay(value.maxDurationMs) &&
    (value.maxDurationMs === 0 || (value.maxDurationMs >= 1000 && value.maxDurationMs % 1000 === 0))
  );
}
export function readRecordingConfig(): RecordingConfig {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem('isaacprof.recording-triggers') ?? 'null',
    );
    if (!value || typeof value !== 'object') return { ...defaults };
    const config = value as Record<string, unknown>;
    return {
      startOn: triggerOptions.some(
        ([id]) => id === config.startOn && id !== 'duration' && id !== 'manual',
      )
        ? (config.startOn as CaptureTrigger)
        : defaults.startOn,
      stopOn: triggerOptions.some(([id]) => id === config.stopOn && id !== 'immediate')
        ? (config.stopOn as CaptureTrigger)
        : defaults.stopOn,
      startDelayMs:
        typeof config.startDelayMs === 'number' && validDelay(config.startDelayMs)
          ? config.startDelayMs
          : 0,
      stopDelayMs:
        typeof config.stopDelayMs === 'number' && validDelay(config.stopDelayMs)
          ? config.stopDelayMs
          : 0,
      maxDurationMs:
        typeof config.maxDurationMs === 'number' &&
        validDelay(config.maxDurationMs) &&
        config.maxDurationMs % 1000 === 0
          ? config.maxDurationMs
          : 0,
    };
  } catch {
    return { ...defaults };
  }
}

export const channelOptions = [
  [1, 'Callback timings'],
  [2, 'Callback timeline'],
  [4, 'Render frames / FPS'],
  [8, 'Update frames / UPS'],
  [16, 'Process CPU / memory'],
  [32, 'Lua heap'],
  [64, 'Room / entity context'],
  [128, 'Run / room markers'],
  [256, 'Profiler overhead'],
  [512, 'Lua error context'],
  [1024, 'Source hashes'],
] as const;
export interface CaptureScope {
  channels: number;
  selectedMods: string[];
  selectedHooks: string[];
}
export const defaultScope: CaptureScope = { channels: 2047, selectedMods: [], selectedHooks: [] };
export function readCaptureScope(): CaptureScope {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('isaacprof.capture-scope') ?? 'null');
    if (!value || typeof value !== 'object') return { ...defaultScope };
    const scope = value as Record<string, unknown>;
    const names = (key: string) =>
      Array.isArray(scope[key]) &&
      scope[key].length <= 128 &&
      scope[key].every(
        (name: unknown) => typeof name === 'string' && name.length > 0 && !/[\r\n\0]/.test(name),
      )
        ? (scope[key] as string[])
        : [];
    return {
      channels:
        typeof scope.channels === 'number' &&
        Number.isInteger(scope.channels) &&
        scope.channels >= 0 &&
        scope.channels <= 2047
          ? scope.channels
          : 2047,
      selectedMods: names('selectedMods'),
      selectedHooks: names('selectedHooks'),
    };
  } catch {
    return { ...defaultScope };
  }
}
