import type { Crate, LibraryState, Track } from './local-library';

export const LIBRARY_BACKUP_VERSION = 1;

export interface LibraryBackup {
  format: 'crateforge-library-backup';
  version: number;
  exportedAt: string;
  tracks: Track[];
  crates: Crate[];
}

export interface RestoreResult {
  tracks: Track[];
  crates: Crate[];
  importedTracks: number;
  duplicateTracks: number;
  importedCrates: number;
  mergedCrates: number;
}

const trackMetadataFields = new Set<keyof Track>([
  'id', 'title', 'artist', 'album', 'genre', 'year', 'durationSeconds', 'bpm',
  'key', 'energy', 'rating', 'fileName', 'filePath', 'fileSize', 'contentHash',
  'source', 'analyzed', 'analysis', 'lockedFields', 'createdAt',
]);
const analysisMetadataFields = new Set([
  'bpm', 'bpmConfidence', 'key', 'camelot', 'keyConfidence', 'energy',
  'durationSeconds', 'beatGridSeconds', 'waveform', 'analyzedAt', 'version',
]);

function metadataOnlyTrack(track: Track): Track {
  const metadata = Object.fromEntries(
    Object.entries(track).filter(([field]) => trackMetadataFields.has(field as keyof Track)),
  ) as Track;
  if (track.analysis) {
    metadata.analysis = Object.fromEntries(
      Object.entries(track.analysis).filter(([field]) => analysisMetadataFields.has(field)),
    ) as Track['analysis'];
  }
  return metadata;
}

const pathKey = (value: string | null | undefined) => value?.replace(/\\/g, '/').toLowerCase() || '';
const newId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

export function createLibraryBackup(state: Pick<LibraryState, 'tracks' | 'crates'>, exportedAt = new Date().toISOString()): LibraryBackup {
  return {
    format: 'crateforge-library-backup',
    version: LIBRARY_BACKUP_VERSION,
    exportedAt,
    tracks: state.tracks.map(metadataOnlyTrack),
    crates: state.crates,
  };
}

export function serializeLibraryBackup(state: Pick<LibraryState, 'tracks' | 'crates'>): string {
  return JSON.stringify(createLibraryBackup(state), null, 2);
}

function isTrack(value: unknown): value is Track {
  if (!value || typeof value !== 'object') return false;
  const track = value as Partial<Track>;
  return typeof track.id === 'string' && typeof track.title === 'string' && typeof track.artist === 'string'
    && typeof track.createdAt === 'string' && typeof track.source === 'string';
}

function isCrate(value: unknown): value is Crate {
  if (!value || typeof value !== 'object') return false;
  const crate = value as Partial<Crate>;
  return typeof crate.id === 'string' && typeof crate.name === 'string'
    && Array.isArray(crate.trackIds) && crate.trackIds.every(id => typeof id === 'string')
    && typeof crate.createdAt === 'string' && typeof crate.updatedAt === 'string';
}

export function parseLibraryBackup(text: string): LibraryBackup {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Backup is not valid JSON.'); }
  if (!value || typeof value !== 'object') throw new Error('Backup must be a JSON object.');
  const backup = value as Partial<LibraryBackup>;
  if (backup.format !== 'crateforge-library-backup') throw new Error('This file is not a Drop Theory Pro library backup.');
  if (backup.version !== LIBRARY_BACKUP_VERSION) {
    throw new Error(`Unsupported backup version ${String(backup.version)}. This Drop Theory Pro version supports version ${LIBRARY_BACKUP_VERSION}.`);
  }
  if (!Array.isArray(backup.tracks) || !backup.tracks.every(isTrack)) throw new Error('Backup contains invalid track metadata.');
  if (!Array.isArray(backup.crates) || !backup.crates.every(isCrate)) throw new Error('Backup contains invalid crate metadata.');
  return { format: backup.format, version: backup.version, exportedAt: String(backup.exportedAt ?? ''), tracks: backup.tracks, crates: backup.crates };
}

export function mergeLibraryBackup(current: Pick<LibraryState, 'tracks' | 'crates'>, backup: LibraryBackup): RestoreResult {
  const tracks = [...current.tracks];
  const crates = current.crates.map(crate => ({ ...crate, trackIds: [...crate.trackIds] }));
  const byIdentity = new Map<string, string>();
  for (const track of tracks) {
    if (track.contentHash) byIdentity.set(`hash:${track.contentHash}`, track.id);
    if (track.filePath) byIdentity.set(`path:${pathKey(track.filePath)}`, track.id);
    byIdentity.set(`id:${track.id}`, track.id);
  }
  const ids = new Set(tracks.map(track => track.id));
  const trackMap = new Map<string, string>();
  let duplicateTracks = 0;
  for (const source of backup.tracks) {
    const existingId = (source.contentHash && byIdentity.get(`hash:${source.contentHash}`))
      ?? (source.filePath && byIdentity.get(`path:${pathKey(source.filePath)}`))
      ?? (ids.has(source.id) ? source.id : undefined);
    if (existingId) {
      trackMap.set(source.id, existingId);
      duplicateTracks += 1;
      continue;
    }
    let id = source.id;
    while (ids.has(id)) id = newId('track');
    const imported = { ...source, id };
    tracks.push(imported);
    ids.add(id);
    trackMap.set(source.id, id);
    if (imported.contentHash) byIdentity.set(`hash:${imported.contentHash}`, id);
    if (imported.filePath) byIdentity.set(`path:${pathKey(imported.filePath)}`, id);
  }
  const crateIds = new Set(crates.map(crate => crate.id));
  let importedCrates = 0;
  let mergedCrates = 0;
  for (const source of backup.crates) {
    const target = crates.find(crate => crate.id === source.id) ?? crates.find(crate => crate.name.trim().toLowerCase() === source.name.trim().toLowerCase());
    if (target) {
      target.trackIds = [...new Set([...target.trackIds, ...source.trackIds.flatMap(id => trackMap.has(id) ? [trackMap.get(id)!] : [])])];
      target.updatedAt = new Date().toISOString();
      mergedCrates += 1;
      continue;
    }
    let id = source.id;
    while (crateIds.has(id)) id = newId('crate');
    crates.push({ ...source, id, trackIds: [...new Set(source.trackIds.flatMap(trackId => trackMap.has(trackId) ? [trackMap.get(trackId)!] : []))] });
    crateIds.add(id);
    importedCrates += 1;
  }
  return { tracks, crates, importedTracks: backup.tracks.length - duplicateTracks, duplicateTracks, importedCrates, mergedCrates };
}