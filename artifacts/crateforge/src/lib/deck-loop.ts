export const LOOP_BEAT_COUNTS = [1, 2, 4, 8] as const;
export type LoopBeatCount = (typeof LOOP_BEAT_COUNTS)[number];

export function getLoopDurationSeconds(
  bpm: number | null | undefined,
  beats: LoopBeatCount,
  trackDuration: number,
): number {
  if (!Number.isFinite(trackDuration) || trackDuration <= 0) return 0;
  const beatDuration = Number.isFinite(bpm) && bpm! > 0 ? (60 / bpm!) * beats : 4;
  return Math.min(beatDuration, trackDuration);
}