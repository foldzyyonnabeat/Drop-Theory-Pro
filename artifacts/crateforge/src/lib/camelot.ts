const NOTE_TO_PITCH_CLASS: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};

const MAJOR_CAMELOT_BY_PITCH = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_CAMELOT_BY_PITCH = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

const KEY_BY_CAMELOT: Record<string, string> = {
  '1A': 'G♯ minor',
  '2A': 'D♯ minor',
  '3A': 'A♯ minor',
  '4A': 'F minor',
  '5A': 'C minor',
  '6A': 'G minor',
  '7A': 'D minor',
  '8A': 'A minor',
  '9A': 'E minor',
  '10A': 'B minor',
  '11A': 'F♯ minor',
  '12A': 'C♯ minor',
  '1B': 'B major',
  '2B': 'F♯ major',
  '3B': 'C♯ major',
  '4B': 'G♯ major',
  '5B': 'D♯ major',
  '6B': 'A♯ major',
  '7B': 'F major',
  '8B': 'C major',
  '9B': 'G major',
  '10B': 'D major',
  '11B': 'A major',
  '12B': 'E major',
};

interface ParsedMusicalKey {
  note: string;
  mode: 'major' | 'minor';
  pitchClass: number;
}

function parseCamelot(value: string): string | null {
  const match = value.trim().match(/^(1[0-2]|[1-9])\s*([AB])$/i);
  return match ? `${Number(match[1])}${match[2].toUpperCase()}` : null;
}

function parseMusicalKey(value: string): ParsedMusicalKey | null {
  const match = value.trim().replace(/♯/g, '#').replace(/♭/g, 'b')
    .match(/^([A-G])\s*([#b]?)\s*(major|maj|minor|min|m)$/i);
  if (!match) return null;

  const accidental = match[2].toLowerCase();
  const note = `${match[1].toUpperCase()}${accidental}`;
  const pitchClass = NOTE_TO_PITCH_CLASS[note];
  if (pitchClass === undefined) return null;

  return {
    note: `${match[1].toUpperCase()}${accidental}`,
    mode: /^(major|maj)$/i.test(match[3]) ? 'major' : 'minor',
    pitchClass,
  };
}

/** Convert a musical key or existing Camelot label to a normalized Camelot label. */
export function camelotForKey(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const camelot = parseCamelot(value);
  if (camelot) return camelot;

  const key = parseMusicalKey(value);
  if (!key) return null;
  return (key.mode === 'major' ? MAJOR_CAMELOT_BY_PITCH : MINOR_CAMELOT_BY_PITCH)[key.pitchClass] ?? null;
}

/** Convert a Camelot label to its conventional musical-key spelling. */
export function musicalKeyForCamelot(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const camelot = parseCamelot(value);
  return camelot ? KEY_BY_CAMELOT[camelot] ?? null : null;
}

/** Show the musical key alongside its Camelot equivalent when one is known. */
export function formatKeyWithCamelot(value: string | null | undefined): string | null {
  const key = value?.trim();
  if (!key) return null;

  const camelot = camelotForKey(key);
  const camelotInput = parseCamelot(key);
  const musicalKey = camelotInput
    ? musicalKeyForCamelot(camelotInput)
    : (() => {
        const parsed = parseMusicalKey(key);
        return parsed ? `${parsed.note} ${parsed.mode}` : key;
      })();

  return `${musicalKey ?? key} · ${camelot ?? '—'}`;
}