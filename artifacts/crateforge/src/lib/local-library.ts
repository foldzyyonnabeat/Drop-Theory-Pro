import { invoke, isTauri } from '@tauri-apps/api/core';
import type { MidiBinding } from './midi-types';

export type TrackSource = 'demo' | 'audio' | 'csv' | 'm3u' | 'rekordbox';

export interface TrackAnalysis {
  bpm: number | null;
  /** Relative confidence scores from 0 to 1 when supplied by the analyzer. */
  bpmConfidence?: number | null;
  key: string | null;
  /** Camelot notation derived from the analyzed musical key. */
  camelot?: string | null;
  keyConfidence?: number | null;
  energy: number | null;
  durationSeconds: number;
  /** Detected beat times in seconds, kept separate from imported/manual metadata. */
  beatGridSeconds?: number[];
  /** Peak amplitude envelope with at most one thousand bins. */
  waveform?: number[];
  analyzedAt: string;
  version: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number | null;
  durationSeconds: number | null;
  bpm: number | null;
  key: string | null;
  energy: number | null;
  rating: number;
  fileName: string | null;
  filePath?: string | null;
  fileSize: number | null;
  contentHash: string | null;
  source: TrackSource;
  analyzed: boolean;
  analysis?: TrackAnalysis | null;
  /** Metadata fields that the user wants analysis estimates to leave unchanged. */
  lockedFields?: LockedMetadataField[];
  createdAt: string;
}

export type LockedMetadataField = 'bpm' | 'key' | 'energy' | 'durationSeconds';

export function analysisApplyPatch(track: Pick<Track, 'bpm' | 'key' | 'energy' | 'durationSeconds' | 'analysis' | 'lockedFields'>): Partial<Track> {
  const analysis = track.analysis;
  if (!analysis) return {};
  const locked = new Set(track.lockedFields ?? []);
  return {
    bpm: locked.has('bpm') ? track.bpm : analysis.bpm ?? track.bpm,
    key: locked.has('key') ? track.key : analysis.key ?? track.key,
    energy: locked.has('energy') ? track.energy : analysis.energy ?? track.energy,
    durationSeconds: locked.has('durationSeconds') ? track.durationSeconds : analysis.durationSeconds,
    analyzed: true,
  };
}

export interface Crate {
  id: string;
  name: string;
  color: string;
  trackIds: string[];
  /** Saved set plans are stored beside crates but remain a distinct workspace type. */
  kind?: 'crate' | 'set';
  createdAt: string;
  updatedAt: string;
}

export interface LibraryState {
  tracks: Track[];
  crates: Crate[];
  updatedAt: string;
}

export interface NativeScanResult {
  tracks: Track[];
  scannedFiles: number;
  metadataWarnings: number;
}

const DATABASE_NAME = 'crateforge-local';
const DATABASE_VERSION = 2;
const STATE_STORE = 'workspace';
const STATE_KEY = 'library';
const AUDIO_STORE = 'browser-audio';
const MIDI_BINDINGS_KEY = 'midi-bindings';
const AUDIO_HASH_LIMIT = 150 * 1024 * 1024;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Database request failed.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('This browser does not support the library database.'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE);
      }
      if (!database.objectStoreNames.contains(AUDIO_STORE)) {
        database.createObjectStore(AUDIO_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the library database.'));
    request.onblocked = () => reject(new Error('The library database is blocked by another open Drop Theory Pro tab.'));
  });
}

export async function loadLibrary(): Promise<LibraryState | null> {
  if (isTauri()) return invoke<LibraryState | null>('load_library_state');
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, 'readonly');
    const state = await requestResult(transaction.objectStore(STATE_STORE).get(STATE_KEY));
    return state ? (state as LibraryState) : null;
  } finally {
    database.close();
  }
}

export async function saveLibrary(state: LibraryState): Promise<void> {
  if (isTauri()) {
    await invoke('save_library_state', {
      state: { ...state, updatedAt: new Date().toISOString() } satisfies LibraryState,
    });
    return;
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).put(
      { ...state, updatedAt: new Date().toISOString() } satisfies LibraryState,
      STATE_KEY,
    );
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the library.'));
      transaction.onabort = () => reject(new Error('Library save was cancelled.'));
    });
  } finally {
    database.close();
  }
}

export async function clearLibrary(): Promise<void> {
  if (isTauri()) {
    await invoke('clear_library_state');
    return;
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).delete(STATE_KEY);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear the library.'));
      transaction.onabort = () => reject(new Error('Clearing the library was cancelled.'));
    });
  } finally {
    database.close();
  }
}

export async function loadBrowserAudioFiles(trackIds: string[]): Promise<Map<string, Blob>> {
  if (isTauri() || trackIds.length === 0) return new Map();
  const database = await openDatabase();
  try {
    const store = database.transaction(AUDIO_STORE, 'readonly').objectStore(AUDIO_STORE);
    const results = await Promise.all(trackIds.map(async id => [id, await requestResult(store.get(id))] as const));
    return new Map(results.flatMap(([id, value]) => value instanceof Blob ? [[id, value] as const] : []));
  } finally {
    database.close();
  }
}

export async function saveBrowserAudioFile(trackId: string, file: Blob): Promise<void> {
  if (isTauri()) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(AUDIO_STORE, 'readwrite');
    transaction.objectStore(AUDIO_STORE).put(file, trackId);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save this audio file.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Saving this audio file was cancelled.'));
    });
  } finally {
    database.close();
  }
}

export async function deleteBrowserAudioFile(trackId: string): Promise<void> {
  if (isTauri()) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(AUDIO_STORE, 'readwrite');
    transaction.objectStore(AUDIO_STORE).delete(trackId);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove this audio file.'));
      transaction.onabort = () => reject(new Error('Removing this audio file was cancelled.'));
    });
  } finally {
    database.close();
  }
}

export async function clearBrowserAudioFiles(): Promise<void> {
  if (isTauri()) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(AUDIO_STORE, 'readwrite');
    transaction.objectStore(AUDIO_STORE).clear();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear stored audio.'));
      transaction.onabort = () => reject(new Error('Clearing stored audio was cancelled.'));
    });
  } finally {
    database.close();
  }
}

export async function loadMidiBindings(): Promise<MidiBinding[]> {
  if (isTauri()) return invoke<MidiBinding[]>('load_midi_bindings');
  const database = await openDatabase();
  try {
    const value = await requestResult(database.transaction(STATE_STORE, 'readonly').objectStore(STATE_STORE).get(MIDI_BINDINGS_KEY));
    return Array.isArray(value) ? value as MidiBinding[] : [];
  } finally {
    database.close();
  }
}

export async function saveMidiBindings(bindings: MidiBinding[]): Promise<void> {
  if (isTauri()) {
    await invoke('save_midi_bindings', { bindings });
    return;
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).put(bindings, MIDI_BINDINGS_KEY);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save MIDI mappings.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Saving MIDI mappings was cancelled.'));
    });
  } finally {
    database.close();
  }
}

const demoTracks: Omit<Track, 'id' | 'createdAt'>[] = [
  { title: 'Golden Hour', artist: 'Mira Sol', album: 'Afterglow', genre: 'Disco House', year: 2023, durationSeconds: 226, bpm: 118, key: '8A', energy: 6, rating: 5, fileName: 'Mira Sol - Golden Hour.flac', fileSize: 28400000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Better Together', artist: 'Northbound', album: 'Open Roads', genre: 'Indie Dance', year: 2022, durationSeconds: 198, bpm: 121, key: '9A', energy: 7, rating: 4, fileName: 'Northbound - Better Together.mp3', fileSize: 9800000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Night Drive', artist: 'June Arcade', album: 'City Lights', genre: 'Nu Disco', year: 2024, durationSeconds: 241, bpm: 122, key: '8B', energy: 8, rating: 5, fileName: 'June Arcade - Night Drive.wav', fileSize: 41800000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Stay Awhile', artist: 'Lena Vale', album: 'Soft Focus', genre: 'House', year: 2021, durationSeconds: 215, bpm: 116, key: '7A', energy: 5, rating: 4, fileName: 'Lena Vale - Stay Awhile.mp3', fileSize: 11200000, contentHash: null, source: 'demo', analyzed: false },
  { title: 'All In', artist: 'Marco Wells', album: 'All In', genre: 'Pop', year: 2020, durationSeconds: 203, bpm: 124, key: '10A', energy: 8, rating: 4, fileName: 'Marco Wells - All In.aiff', fileSize: 36100000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Sunday Morning', artist: 'The Coastline', album: 'Easy Does It', genre: 'Soul', year: 2019, durationSeconds: 232, bpm: 102, key: '6A', energy: 3, rating: 5, fileName: 'The Coastline - Sunday Morning.flac', fileSize: 25200000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Make It Move', artist: 'Daya North', album: 'Motion', genre: 'Dance Pop', year: 2024, durationSeconds: 187, bpm: 126, key: '11A', energy: 9, rating: 5, fileName: 'Daya North - Make It Move.mp3', fileSize: 9100000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Blue Skies', artist: 'Eli & The Lights', album: 'Open Roads', genre: 'Indie', year: 2022, durationSeconds: 219, bpm: 110, key: '5A', energy: 4, rating: 3, fileName: 'Eli and The Lights - Blue Skies.mp3', fileSize: 10600000, contentHash: null, source: 'demo', analyzed: false },
  { title: 'One More Time', artist: 'Rae Collins', album: 'One More Time', genre: 'House', year: 2023, durationSeconds: 228, bpm: 124, key: '9B', energy: 9, rating: 5, fileName: 'Rae Collins - One More Time.flac', fileSize: 29200000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Slow Burn', artist: 'Theo Mercer', album: 'Late Set', genre: 'R&B', year: 2021, durationSeconds: 244, bpm: 92, key: '4A', energy: 3, rating: 4, fileName: 'Theo Mercer - Slow Burn.mp3', fileSize: 11800000, contentHash: null, source: 'demo', analyzed: false },
  { title: 'Electric Feeling', artist: 'Violet Theory', album: 'Voltage', genre: 'Electro Pop', year: 2025, durationSeconds: 194, bpm: 128, key: '12A', energy: 10, rating: 5, fileName: 'Violet Theory - Electric Feeling.wav', fileSize: 33800000, contentHash: null, source: 'demo', analyzed: true },
  { title: 'Keep It Close', artist: 'Arlo James', album: 'Good Company', genre: 'Funk', year: 2018, durationSeconds: 207, bpm: 106, key: '3A', energy: 5, rating: 3, fileName: 'Arlo James - Keep It Close.mp3', fileSize: 10100000, contentHash: null, source: 'demo', analyzed: false },
];

export function createDemoLibrary(): LibraryState {
  const now = new Date().toISOString();
  const tracks = demoTracks.map((track) => ({ ...track, id: crypto.randomUUID(), createdAt: now }));
  const crates: Crate[] = [
    {
      id: crypto.randomUUID(),
      name: 'Cocktail Hour',
      color: '#A3E635',
      trackIds: tracks.filter((track) => track.energy !== null && track.energy <= 5).map((track) => track.id),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: crypto.randomUUID(),
      name: 'Dancefloor',
      color: '#22C55E',
      trackIds: tracks.filter((track) => track.energy !== null && track.energy >= 8).map((track) => track.id),
      createdAt: now,
      updatedAt: now,
    },
  ];
  return { tracks, crates, updatedAt: now };
}

function makeTrackId(): string {
  return crypto.randomUUID();
}

function numberOrNull(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function normalizedKey(value: string | undefined): string | null {
  const key = value?.trim();
  return key ? key.toUpperCase() : null;
}

function cleanText(value: string | undefined): string {
  return (value ?? '').trim();
}

function guessArtistAndTitle(input: string): { artist: string; title: string } {
  const base = input.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '').trim() ?? input.trim();
  const separator = base.match(/^(.+?)\s+-\s+(.+)$/);
  if (separator) return { artist: separator[1].trim(), title: separator[2].trim() };
  return { artist: '', title: base || 'Untitled track' };
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell.replace(/\r$/, ''));
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function trackFromColumns(
  values: Record<string, string>,
  source: 'csv' | 'm3u',
): Track {
  const name = cleanText(values.title ?? values.track ?? values.name);
  const guessed = guessArtistAndTitle(name || values.path || '');
  const bpm = numberOrNull(values.bpm ?? values.tempo);
  const energy = numberOrNull(values.energy);
  const rating = numberOrNull(values.rating) ?? 0;
  return {
    id: makeTrackId(),
    title: name || guessed.title,
    artist: cleanText(values.artist) || guessed.artist,
    album: cleanText(values.album),
    genre: cleanText(values.genre),
    year: numberOrNull(values.year),
    durationSeconds: numberOrNull(values.duration ?? values.durationseconds),
    bpm,
    key: normalizedKey(values.key ?? values.musicalkey),
    energy: energy === null ? null : Math.max(1, Math.min(10, Math.round(energy))),
    rating: Math.max(0, Math.min(5, Math.round(rating))),
    fileName: cleanText(values.path ?? values.filename) || null,
    fileSize: null,
    contentHash: null,
    source,
    analyzed: bpm !== null || normalizedKey(values.key ?? values.musicalkey) !== null,
    createdAt: new Date().toISOString(),
  };
}

export function parseCsvTracks(text: string): Track[] {
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one track.');

  const headers = rows[0].map((value) => value.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  if (!headers.some((header) => ['title', 'track', 'name', 'path', 'filename'].includes(header))) {
    throw new Error('CSV must include a Title, Track, Name, Path, or Filename column.');
  }

  return rows.slice(1).map((row) => {
    const values: Record<string, string> = {};
    headers.forEach((header, index) => {
      values[header] = row[index] ?? '';
    });
    return trackFromColumns(values, 'csv');
  });
}

export function parseM3uTracks(text: string): Track[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const tracks: Track[] = [];
  let nextTitle = '';
  let nextDuration: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/^#EXTINF:([^,]+),(.*)$/);
      const parsedDuration = match ? numberOrNull(match[1]) : null;
      nextDuration = parsedDuration !== null && parsedDuration >= 0 ? parsedDuration : null;
      nextTitle = match?.[2]?.trim() ?? '';
      continue;
    }
    if (line.startsWith('#')) continue;

    const guessed = guessArtistAndTitle(nextTitle || line);
    tracks.push(
      trackFromColumns(
        {
          title: nextTitle || guessed.title,
          artist: guessed.artist,
          path: line,
          duration: nextDuration === null ? '' : String(nextDuration),
        },
        'm3u',
      ),
    );
    nextTitle = '';
    nextDuration = null;
  }

  if (tracks.length === 0) throw new Error('No playlist tracks were found in this M3U file.');
  return tracks;
}

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos') return "'";
    const number = code.toLowerCase().startsWith('#x')
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    try { return Number.isFinite(number) ? String.fromCodePoint(number) : entity; } catch { return entity; }
  });
}

function xmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  for (const match of source.matchAll(matcher)) {
    attributes[match[1]] = decodeXml(match[2].slice(1, -1));
  }
  return attributes;
}

function parseXmlTree(text: string): XmlNode {
  if (text.length > 25 * 1024 * 1024) throw new Error('rekordbox XML is larger than the 25 MB safe import limit.');
  if (/<!DOCTYPE/i.test(text)) throw new Error('XML documents with a DOCTYPE are not accepted.');
  const root: XmlNode = { name: '#document', attributes: {}, children: [] };
  const stack = [root];
  const tags = text.match(/<!--[\s\S]*?-->|<\?[^>]*\?>|<![^>]*>|<\/?[^>]+>/g) ?? [];
  if (!tags.length) throw new Error('This file does not contain readable XML.');
  if (tags.length > 500_000) throw new Error('rekordbox XML has more than 500,000 elements and exceeds the safe import limit.');

  for (const token of tags) {
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const closingName = token.slice(2, -1).trim().split(/\s/)[0];
      if (stack.length <= 1 || stack[stack.length - 1].name !== closingName) {
        throw new Error('rekordbox XML has an unmatched closing tag.');
      }
      stack.pop();
      continue;
    }
    const body = token.slice(1, -1).trim();
    const selfClosing = /\/\s*$/.test(body);
    const tagMatch = body.match(/^([A-Za-z_:][\w:.-]*)/);
    if (!tagMatch) continue;
    const node: XmlNode = {
      name: tagMatch[1],
      attributes: xmlAttributes(body.slice(tagMatch[0].length)),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length >= 128) throw new Error('rekordbox XML nesting is deeper than the safe import limit.');
      stack.push(node);
    }
  }
  if (stack.length !== 1) throw new Error('rekordbox XML is incomplete or malformed.');
  return root;
}

function xmlRatingToStars(value: string | undefined): number {
  const raw = xmlNumber(value);
  if (raw === null) return 0;
  const stars = raw > 5 ? Math.round(raw / 51) : Math.round(raw);
  return Math.max(0, Math.min(5, stars));
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === name) result.push(child);
    result.push(...descendants(child, name));
  }
  return result;
}

function xmlNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function rekordboxLocationToPath(location: string | undefined): string | null {
  if (!location) return null;
  let path = location;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path.replace(/^file:\/\/localhost\//i, 'file:///'));
      path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
      if (/^[A-Za-z]:\//.test(path)) path = path.replace(/\//g, '\\');
    } catch {
      return null;
    }
  }
  return path || null;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pathToFileUri(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const absolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/');
  const encoded = normalized.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `file://localhost/${absolute ? encoded.replace(/^\/+/, '') : encoded}`;
}

/**
 * Imports rekordbox's documented XML export format only. It never reads or
 * writes rekordbox's live database.
 */
export function parseRekordboxXml(text: string): { tracks: Track[]; crates: Crate[] } {
  const document = parseXmlTree(text);
  const collection = descendants(document, 'COLLECTION')[0];
  if (!collection) throw new Error('rekordbox XML is missing its COLLECTION section.');
  const trackNodes = descendants(collection, 'TRACK');
  if (!trackNodes.length) throw new Error('No tracks were found in the rekordbox XML collection.');

  const idMap = new Map<string, string>();
  const tracks = trackNodes.map((node) => {
    const attributes = node.attributes;
    const sourceId = attributes.TrackID?.trim();
    const track: Track = {
      id: makeTrackId(),
      title: attributes.Name?.trim() || 'Untitled track',
      artist: attributes.Artist?.trim() || '',
      album: attributes.Album?.trim() || '',
      genre: attributes.Genre?.trim() || '',
      year: xmlNumber(attributes.Year),
      durationSeconds: xmlNumber(attributes.TotalTime),
      bpm: xmlNumber(attributes.AverageBpm),
      key: normalizedKey(attributes.Tonality),
      energy: null,
      rating: xmlRatingToStars(attributes.Rating),
      fileName: attributes.Location?.split(/[\\/]/).pop() ?? null,
      filePath: rekordboxLocationToPath(attributes.Location),
      fileSize: null,
      contentHash: null,
      source: 'rekordbox',
      analyzed: xmlNumber(attributes.AverageBpm) !== null || Boolean(attributes.Tonality?.trim()),
      createdAt: new Date().toISOString(),
    };
    if (sourceId) idMap.set(sourceId, track.id);
    return track;
  });

  const playlistRoot = descendants(document, 'PLAYLISTS')[0];
  const crates: Crate[] = [];
  const addPlaylist = (node: XmlNode, folders: string[]) => {
    const name = node.attributes.Name?.trim();
    if (!name) return;
    const kind = node.attributes.Type;
    const childNodes = node.children.filter(item => item.name === 'NODE');
    if (kind === '1' || name.toUpperCase() === 'ROOT') {
      const nextFolders = name.toUpperCase() === 'ROOT' ? folders : [...folders, name];
      for (const child of childNodes) addPlaylist(child, nextFolders);
      return;
    }
    if (kind !== '0') return;
    const trackIds = node.children.filter(item => item.name === 'TRACK')
      .map(trackNode => idMap.get(trackNode.attributes.Key ?? ''))
      .filter((id): id is string => Boolean(id));
    if (!trackIds.length && childNodes.length) {
      for (const child of childNodes) addPlaylist(child, [...folders, name]);
      return;
    }
    crates.push({
      id: makeTrackId(),
      name: [...folders, name].join(' / '),
      color: '#62d5c4',
      trackIds: [...new Set(trackIds)],
      kind: 'crate',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };
  if (playlistRoot) {
    for (const node of playlistRoot.children.filter(item => item.name === 'NODE')) addPlaylist(node, []);
  }
  return { tracks, crates };
}

/**
 * Creates a safe-to-review XML export. The generated file does not modify the
 * live rekordbox database and intentionally reports that cue/grid metadata is
 * not represented by this first export path.
 */
export function exportRekordboxXml(tracks: Track[], crates: Crate[]): string {
  const ids = new Map(tracks.map((track, index) => [track.id, String(index + 1)]));
  const trackXml = tracks.map((track, index) => {
    const location = track.filePath || '';
    const uri = location ? pathToFileUri(location) : '';
    const attributes: Record<string, string> = {
      TrackID: String(index + 1),
      Name: track.title,
      Artist: track.artist,
      Album: track.album,
      Genre: track.genre,
      Year: track.year === null ? '' : String(track.year),
      TotalTime: String(Math.max(0, Math.round(track.durationSeconds ?? 0))),
      AverageBpm: track.bpm === null ? '' : String(track.bpm),
      Tonality: track.key ?? '',
      Rating: String(Math.max(0, Math.min(5, Math.round(track.rating))) * 51),
      Location: uri,
    };
    return `    <TRACK ${Object.entries(attributes).map(([key, value]) => `${key}="${xmlEscape(value)}"`).join(' ')} />`;
  }).join('\n');
  const playlistXml = crates.map(crate => {
    const refs = crate.trackIds.flatMap(id => {
      const key = ids.get(id);
      return key ? [`      <TRACK Key="${key}" />`] : [];
    }).join('\n');
    return `    <NODE Type="0" Name="${xmlEscape(crate.name)}" KeyType="0">\n${refs}\n    </NODE>`;
  }).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="Drop Theory Pro" Version="1" Company="Drop Theory Pro" />',
    '  <COLLECTION Entries="' + tracks.length + '">',
    trackXml,
    '  </COLLECTION>',
    '  <PLAYLISTS>',
    '    <NODE Type="0" Name="ROOT" KeyType="0">',
    playlistXml,
    '    </NODE>',
    '  </PLAYLISTS>',
    '</DJ_PLAYLISTS>',
  ].join('\n');
}

async function readAudioDuration(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = new Audio();
      let settled = false;
      const finish = (duration: number | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.src = '';
        resolve(duration);
      };
      const timeout = window.setTimeout(() => finish(null), 15_000);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null);
      audio.onerror = () => finish(null);
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function sha256IfSmall(file: File): Promise<string | null> {
  if (file.size > AUDIO_HASH_LIMIT || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function importAudioFiles(files: FileList | File[]): Promise<Track[]> {
  const imported: Track[] = [];
  for (const file of Array.from(files)) {
    const guessed = guessArtistAndTitle(file.name);
    const [durationSeconds, contentHash] = await Promise.all([
      readAudioDuration(file),
      sha256IfSmall(file),
    ]);
    imported.push({
      id: makeTrackId(),
      title: guessed.title,
      artist: guessed.artist,
      album: '',
      genre: '',
      year: null,
      durationSeconds,
      bpm: null,
      key: null,
      energy: null,
      rating: 0,
      fileName: file.name,
      fileSize: file.size,
      contentHash,
      source: 'audio',
      analyzed: false,
      createdAt: new Date().toISOString(),
    });
  }
  return imported;
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportTracksCsv(tracks: Track[]): string {
  const columns: (keyof Track)[] = [
    'title',
    'artist',
    'album',
    'genre',
    'year',
    'durationSeconds',
    'bpm',
    'key',
    'energy',
    'rating',
    'fileName',
  ];
  return [
    columns.join(','),
    ...tracks.map((track) => columns.map((column) => csvEscape(track[column])).join(',')),
  ].join('\r\n');
}

export function exportCrateM3u(crate: Crate, tracks: Track[]): string {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const output = ['#EXTM3U'];
  for (const id of crate.trackIds) {
    const track = byId.get(id);
    if (!track) continue;
    const artistTitle = [track.artist, track.title].filter(Boolean).join(' - ') || track.title;
    const duration = track.durationSeconds === null ? -1 : Math.round(track.durationSeconds);
    output.push(`#EXTINF:${duration},${artistTitle}`);
    output.push(track.filePath || track.fileName || artistTitle);
  }
  return output.join('\r\n');
}

export function exportTracksM3u(tracks: Track[]): string {
  return exportCrateM3u(
    {
      id: 'library',
      name: 'Library',
      color: '#62d5c4',
      trackIds: tracks.map((track) => track.id),
      createdAt: '',
      updatedAt: '',
    },
    tracks,
  );
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}