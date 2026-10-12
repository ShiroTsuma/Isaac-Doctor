import type { CaptureScope, RecordingConfig } from './recording-config.ts';
import { triggerOptions, validDelay } from './recording-config.ts';

export interface RecordingPreferences extends CaptureScope, RecordingConfig {
  seconds: number;
  screenshots: boolean;
  screenshotMs: number;
  minimumUs: number;
}

export function parseRecordingPreferences(
  value: unknown,
): RecordingPreferences {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('recording' in value) ||
    !value.recording ||
    typeof value.recording !== 'object'
  ) {
    throw Error('Unsupported recording settings format');
  }
  const r = value.recording as Record<string, unknown>;
  const integer = (key: string, minimum: number, maximum: number) => {
    const v = r[key];
    if (
      typeof v !== 'number' ||
      !Number.isInteger(v) ||
      v < minimum ||
      v > maximum
    ) {
      throw Error(`Invalid recording setting: ${key}`);
    }
    return v;
  };
  const names = (key: string) => {
    const v = r[key];
    if (
      !Array.isArray(v) ||
      v.length > 128 ||
      !v.every(
        (n: unknown) => typeof n === 'string' && !!n && !/[\r\n\0]/.test(n),
      ) ||
      v.reduce(
        (total: number, n: string) =>
          total + new TextEncoder().encode(n).length + 1,
        0,
      ) >= 4096
    ) {
      throw Error(`Invalid recording scope: ${key}`);
    }
    return v as string[];
  };
  const startOn = triggerOptions.find(
    ([id]) => id === r.startOn && id !== 'duration' && id !== 'manual',
  )?.[0];
  const stopOn = triggerOptions.find(
    ([id]) => id === r.stopOn && id !== 'immediate',
  )?.[0];
  if (!startOn || !stopOn || typeof r.screenshots !== 'boolean') {
    throw Error('Invalid recording triggers or screenshots');
  }
  const maxDurationMs = integer('maxDurationMs', 0, 3600000);
  if (!validDelay(maxDurationMs) || maxDurationMs % 1000) {
    throw Error('Invalid maximum duration');
  }
  return {
    seconds: integer('seconds', 1, 3600),
    screenshots: r.screenshots,
    screenshotMs: integer('screenshotMs', 250, 10000),
    minimumUs: integer('minimumUs', 0, 1000000),
    channels: integer('channels', 0, 16383),
    selectedMods: names('selectedMods'),
    selectedHooks: names('selectedHooks'),
    startOn,
    stopOn,
    startDelayMs: integer('startDelayMs', 0, 3600000),
    stopDelayMs: integer('stopDelayMs', 0, 3600000),
    maxDurationMs,
  };
}
