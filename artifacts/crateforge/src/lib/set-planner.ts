import type { Track } from './local-library';
import { camelotForKey, formatKeyWithCamelot } from './camelot';

export type EnergyArc = 'steady-rise' | 'wave' | 'peak-and-valley' | 'plateau';

export interface SetPlanOptions {
  durationMinutes: number;
  startBpm: number;
  endBpm: number;
  arc: EnergyArc;
}

export interface SetPlanResult {
  tracks: Track[];
  targetSeconds: number;
  plannedSeconds: number;
  complete: boolean;
}

export function camelotDistance(left: string | null, right: string | null): number {
  const parse = (value: string | null) => {
    const match = camelotForKey(value)?.match(/^(1[0-2]|[1-9])([AB])$/);
    return match ? { number: Number(match[1]), mode: match[2].toUpperCase() } : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 3;
  if (a.number === b.number && a.mode === b.mode) return 0;
  if (a.number === b.number && a.mode !== b.mode) return 1;
  const raw = Math.abs(a.number - b.number);
  const wheelDistance = Math.min(raw, 12 - raw);
  if (a.mode === b.mode && wheelDistance === 1) return 1;
  if (a.mode === b.mode && (wheelDistance === 5 || wheelDistance === 7)) return 1.5;
  return 2 + wheelDistance / 3 + (a.mode === b.mode ? 0 : 0.5);
}

export function targetEnergy(arc: EnergyArc, progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  if (arc === 'steady-rise') return 3 + 6 * t;
  if (arc === 'plateau') return 6.5;
  if (arc === 'wave') return 5.5 + 2.5 * Math.sin(2 * Math.PI * t - Math.PI / 2);
  if (t < 0.34) return 3 + (6 * t) / 0.34;
  if (t < 0.62) return 9 - (4 * (t - 0.34)) / 0.28;
  if (t < 0.86) return 5 + (4 * (t - 0.62)) / 0.24;
  return 9 - (3 * (t - 0.86)) / 0.14;
}

function tempoDistance(actual: number | null, target: number): number {
  if (!actual || actual <= 0) return 16;
  const variants = [actual, actual / 2, actual * 2];
  return Math.min(...variants.map(value => Math.abs(value - target)));
}

function candidateCost(track: Track, progress: number, options: SetPlanOptions, previous: Track | undefined): number {
  const targetBpm = options.startBpm + (options.endBpm - options.startBpm) * progress;
  const energyError = track.energy === null ? 3.5 : Math.abs(track.energy - targetEnergy(options.arc, progress));
  const bpmError = tempoDistance(track.bpm, targetBpm);
  const keyError = previous ? camelotDistance(previous.key, track.key) : 0;
  const ratingBonus = Math.max(0, Math.min(5, track.rating)) * 0.12;
  return energyError * 1.6 + bpmError * 0.16 + keyError * 1.25 - ratingBonus;
}

/**
 * Builds a deterministic local-only set suggestion. It uses only metadata
 * already in the library and leaves the user's track order untouched.
 */
export function planSet(tracks: Track[], options: SetPlanOptions): SetPlanResult {
  const targetSeconds = Math.max(1, Math.round(options.durationMinutes * 60));
  const remaining = tracks.filter(track =>
    Number.isFinite(track.durationSeconds) && (track.durationSeconds ?? 0) > 0,
  );
  const planned: Track[] = [];
  let plannedSeconds = 0;

  while (remaining.length && plannedSeconds < targetSeconds) {
    const progress = Math.min(1, plannedSeconds / targetSeconds);
    const previous = planned[planned.length - 1];
    let bestIndex = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const cost = candidateCost(remaining[index], progress, options, previous);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    planned.push(chosen);
    plannedSeconds += chosen.durationSeconds ?? 0;
  }

  return { tracks: planned, targetSeconds, plannedSeconds, complete: plannedSeconds >= targetSeconds };
}

export function explainTransition(previous: Track, next: Track): string {
  const distance = camelotDistance(previous.key, next.key);
  const previousKey = formatKeyWithCamelot(previous.key) ?? 'unknown';
  const nextKey = formatKeyWithCamelot(next.key) ?? 'unknown';
  const keyReason = distance === 0
    ? `same Camelot key (${camelotForKey(previous.key) ?? 'unknown'})`
    : distance <= 1
      ? `harmonically close keys (${previousKey} → ${nextKey})`
      : `a noticeable key change (${previousKey} → ${nextKey})`;
  const bpmDelta = previous.bpm !== null && next.bpm !== null
    ? Math.abs(previous.bpm - next.bpm)
    : null;
  const tempoReason = bpmDelta === null
    ? 'tempo data is incomplete'
    : bpmDelta <= 4
      ? `a ${bpmDelta.toFixed(1)} BPM change`
      : `a ${bpmDelta.toFixed(1)} BPM change that may need a bridge`;
  return `${keyReason}; ${tempoReason}. This is a metadata estimate, not an audio audition.`;
}