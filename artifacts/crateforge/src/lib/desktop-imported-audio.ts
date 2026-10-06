type DesktopInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const retainedDesktopAudio = new Map<string, Blob>();

export function retainDesktopImportedAudioTrack(trackId: string, audio: Blob): void {
  retainedDesktopAudio.set(trackId, audio);
}

export function releaseDesktopImportedAudioTrack(trackId: string): void {
  retainedDesktopAudio.delete(trackId);
}

export function selectNewDesktopAudioAssignments<
  TTrack extends { id: string },
  TFile,
>(
  importedTracks: TTrack[],
  audioFiles: TFile[],
  addedTracks: TTrack[],
): Array<{ trackId: string; file: TFile }> {
  if (importedTracks.length !== audioFiles.length) {
    throw new Error('Imported audio tracks and source files are out of sync.');
  }

  const fileByTrackId = new Map<string, TFile>();
  importedTracks.forEach((track, index) => {
    if (fileByTrackId.has(track.id)) {
      throw new Error(`Imported audio contains a duplicate track ID: ${track.id}`);
    }
    fileByTrackId.set(track.id, audioFiles[index]);
  });

  const assignedIds = new Set<string>();
  return addedTracks.flatMap(track => {
    if (!fileByTrackId.has(track.id) || assignedIds.has(track.id)) return [];
    const file = fileByTrackId.get(track.id);
    assignedIds.add(track.id);
    return [{ trackId: track.id, file: file as TFile }];
  });
}

export async function listDesktopImportedAudio(
  trackIds: string[],
  invokeCommand: DesktopInvoke,
): Promise<Set<string>> {
  const savedTrackIds = await invokeCommand<string[]>(
    'list_imported_audio',
    { trackIds },
  );
  return new Set(savedTrackIds.filter(trackId => trackIds.includes(trackId)));
}

export function findMissingDesktopImportedAudioTrackIds(
  tracks: Array<{ id: string; source: string; filePath?: string | null }>,
  savedTrackIds: ReadonlySet<string>,
): Set<string> {
  return new Set(
    tracks
      .filter(track => track.source === 'audio' && !track.filePath && !savedTrackIds.has(track.id))
      .map(track => track.id),
  );
}

export async function loadDesktopImportedAudioTrack(
  trackId: string,
  invokeCommand: DesktopInvoke,
): Promise<Blob | null> {
  const retainedAudio = retainedDesktopAudio.get(trackId);
  if (retainedAudio) return retainedAudio;

  const audioByTrack = await invokeCommand<Record<string, number[]>>(
    'load_imported_audio',
    { trackIds: [trackId] },
  );
  const bytes = audioByTrack[trackId];
  return bytes?.length ? new Blob([new Uint8Array(bytes)]) : null;
}

export async function saveDesktopImportedAudio(
  trackId: string,
  fileName: string,
  audio: Blob,
  invokeCommand: DesktopInvoke,
): Promise<void> {
  try {
    await invokeCommand('save_imported_audio', {
      trackId,
      fileName,
      audioBytes: Array.from(new Uint8Array(await audio.arrayBuffer())),
    });
  } catch (error) {
    retainDesktopImportedAudioTrack(trackId, audio);
    throw error;
  }
  retainedDesktopAudio.delete(trackId);
}

export async function deleteDesktopImportedAudio(
  trackId: string,
  invokeCommand: DesktopInvoke,
): Promise<void> {
  await invokeCommand('delete_imported_audio', { trackId });
  retainedDesktopAudio.delete(trackId);
}