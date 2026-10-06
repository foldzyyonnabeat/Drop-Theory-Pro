import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDownUp, Check, ChevronDown, CircleHelp, Database,
  Disc3, Download, Filter, FolderOpen, LayoutDashboard, LibraryBig, ListMusic, Menu, Music2,
  Pencil, Plus, RotateCcw, Search, ShieldCheck, Trash2, Upload, X, Layers3, Split,
} from 'lucide-react';
import { DecksWorkspace } from '@/components/DecksWorkspace';
import { StemStudioWorkspace } from '@/components/StemStudioWorkspace';
import { CommandPalette, type WorkspaceTab } from '@/components/CommandPalette';
import { SetPlanner } from '@/components/SetPlanner';
import { LicensesPage } from '@/components/LicensesPage';
import { WindowChrome } from '@/components/WindowChrome';
import dropTheoryProLogo from '@/assets/drop-theory-pro-logo.png';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog';
import {
  createDemoLibrary,
  clearBrowserAudioFiles,
  deleteBrowserAudioFile,
  downloadTextFile,
  analysisApplyPatch,
  exportCrateM3u,
  exportTracksCsv,
  exportTracksM3u,
  importAudioFiles,
  loadBrowserAudioFiles,
  loadLibrary,
  parseCsvTracks,
  parseM3uTracks,
  parseRekordboxXml,
  exportRekordboxXml,
  saveLibrary,
  saveBrowserAudioFile,
  type Crate,
  type LockedMetadataField,
  type NativeScanResult,
  type TrackAnalysis,
  type Track,
} from '@/lib/local-library';
import { createLibraryBackup, mergeLibraryBackup, parseLibraryBackup } from '@/lib/library-backup';
import {
  deleteDesktopImportedAudio,
  findMissingDesktopImportedAudioTrackIds,
  listDesktopImportedAudio,
  loadDesktopImportedAudioTrack,
  releaseDesktopImportedAudioTrack,
  retainDesktopImportedAudioTrack,
  selectNewDesktopAudioAssignments,
  saveDesktopImportedAudio,
} from '@/lib/desktop-imported-audio';
import { camelotForKey, formatKeyWithCamelot } from '@/lib/camelot';

type Tab = WorkspaceTab;
type ViewMode = 'beginner' | 'standard' | 'pro';

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
const isLockableMetadataField = (value: string): value is LockedMetadataField =>
  value === 'bpm' || value === 'key' || value === 'energy' || value === 'durationSeconds';

const fmtTime = (seconds: number | null) => seconds === null ? '—' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function filterNewTracks(existing: Track[], incoming: Track[]): Track[] {
  const knownHashes = new Set(existing.flatMap(track => track.contentHash ? [track.contentHash] : []));
  const knownPaths = new Set(existing.flatMap(track => track.filePath ? [track.filePath.replace(/\\/g, '/').toLowerCase()] : []));
  const seenHashes = new Set<string>();
  const seenPaths = new Set<string>();
  return incoming.filter(track => {
    if (track.filePath) {
      const path = track.filePath.replace(/\\/g, '/').toLowerCase();
      if (knownPaths.has(path) || seenPaths.has(path)) return false;
      seenPaths.add(path);
    }
    if (track.contentHash) {
      if (knownHashes.has(track.contentHash) || seenHashes.has(track.contentHash)) return false;
      seenHashes.add(track.contentHash);
    }
    return true;
  });
}

function useWorkspace() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [crates, setCrates] = useState<Crate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadLibrary().then(value => {
      if (cancelled) return;
      setTracks(value?.tracks ?? []);
      setCrates(value?.crates ?? []);
      setStorageReady(true);
      setLoaded(true);
    }).catch(error => {
      if (cancelled) return;
      setStorageError(error instanceof Error ? error.message : 'Could not open library storage.');
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    const timer = window.setTimeout(() => {
      saveLibrary({ tracks, crates, updatedAt: now() })
        .then(() => setStorageError(''))
        .catch(error => setStorageError(error instanceof Error ? error.message : 'Could not save the library.'));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [tracks, crates, storageReady]);
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3200); };
  const loadDemo = () => {
    if ((tracks.length > 0 || crates.length > 0) && !window.confirm('Replace your current library with the sample library? Your existing tracks and crates will be removed.')) return false;
    const demo = createDemoLibrary();
    setTracks(demo.tracks);
    setCrates(demo.crates);
    notify('Sample library loaded. It contains metadata, not audio files.');
    return true;
  };
  const addTracks = (incoming: Track[]): Track[] => {
    const unique = filterNewTracks(tracks, incoming);
    setTracks(previous => [...filterNewTracks(previous, unique), ...previous]);
    if (unique.length) notify(`${unique.length} new item${unique.length === 1 ? '' : 's'} added.`);
    else if (incoming.length) notify('Those tracks are already in this library.');
    return unique;
  };
  const updateTrack = (id: string, patch: Partial<Track>) => setTracks(previous => previous.map(track => track.id === id ? { ...track, ...patch } : track));
  const deleteTrack = (id: string) => { setTracks(previous => previous.filter(track => track.id !== id)); setCrates(previous => previous.map(crate => ({ ...crate, trackIds: crate.trackIds.filter(trackId => trackId !== id) }))); notify('Track removed from the library.'); };
  return { tracks, crates, loaded, notice, storageError, loadDemo, addTracks, updateTrack, deleteTrack, setTracks, setCrates, notify };
}

export function DropTheoryWorkspace() {
  const workspace = useWorkspace();
  const desktopRuntime = isTauri();
  const [failedDesktopAudioSaves, setFailedDesktopAudioSaves] = useState<Map<string, {
    fileName: string;
    audio: Blob;
    error: string;
  }>>(() => new Map());
  const [retryingDesktopAudioIds, setRetryingDesktopAudioIds] = useState<Set<string>>(() => new Set());
  const [nativeFolder, setNativeFolder] = useState<string | null>(null);
  const [missingNativePaths, setMissingNativePaths] = useState<Set<string>>(() => new Set());
  const nativeFilePaths = useMemo(() => workspace.tracks.flatMap(track => track.filePath ? [track.filePath] : []), [workspace.tracks]);
  const nativeFilePathsKey = nativeFilePaths.join('\u0000');
  const [browserAudioFiles, setBrowserAudioFiles] = useState<Map<string, Blob>>(() => new Map());
  const [browserAudioSavedTrackIds, setBrowserAudioSavedTrackIds] = useState<Set<string>>(() => new Set());
  const [failedBrowserAudioSaves, setFailedBrowserAudioSaves] = useState<Map<string, {
    fileName: string;
    audio: Blob;
    error: string;
  }>>(() => new Map());
  const [retryingBrowserAudioIds, setRetryingBrowserAudioIds] = useState<Set<string>>(() => new Set());
  const retryingBrowserAudioIdsRef = useRef(new Set<string>());
  const [desktopImportedAudioIds, setDesktopImportedAudioIds] = useState<Set<string>>(() => new Set());
  const [desktopAudioPresenceChecked, setDesktopAudioPresenceChecked] = useState(false);
  const [browserAudioHydrated, setBrowserAudioHydrated] = useState(!desktopRuntime);
  const missingTempoKeyCount = workspace.tracks.filter(track => track.bpm === null || track.key === null).length;
  const [tab, setTab] = useState<Tab>('overview');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('crateforge-view-mode');
      return saved === 'beginner' || saved === 'pro' ? saved : 'standard';
    } catch {
      return 'standard';
    }
  });
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'import' | 'edit' | 'crate' | 'export' | null>(null);
  const [editing, setEditing] = useState<Track | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<'title' | 'bpm' | 'year'>('title');
  const [undo, setUndo] = useState<{ message: string; action: () => void } | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const restoreDesktopAudioInputRef = useRef<HTMLInputElement>(null);
  const restoreDesktopAudioTrackIdRef = useRef<string | null>(null);
  const removingTrackIdsRef = useRef(new Set<string>());
  const retryingDesktopAudioIdsRef = useRef(new Set<string>());
  useEffect(() => {
    try { localStorage.setItem('crateforge-view-mode', viewMode); } catch { /* The mode is a convenience, not required for operation. */ }
  }, [viewMode]);
  useEffect(() => {
    if (!desktopRuntime) return;
    const root = document.documentElement;
    root.classList.add('desktop-window');
    return () => root.classList.remove('desktop-window');
  }, [desktopRuntime]);
  useEffect(() => {
    if (!desktopRuntime) return;
    let active = true;
    invoke<string | null>('get_music_folder')
      .then(path => { if (active) setNativeFolder(path); })
      .catch(error => { if (active) workspace.notify(error instanceof Error ? error.message : 'Could not read the saved music folder.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!desktopRuntime || !workspace.loaded) {
      setMissingNativePaths(new Set());
      return;
    }
    if (!nativeFilePaths.length) {
      setMissingNativePaths(new Set());
      return;
    }
    let active = true;
    let request = 0;
    const checkFiles = () => {
      if (document.visibilityState === 'hidden') return;
      const currentRequest = ++request;
      invoke<string[]>('check_music_files', { paths: nativeFilePaths })
        .then(paths => {
          if (active && currentRequest === request) setMissingNativePaths(new Set(paths));
        })
        .catch(error => {
          if (active && currentRequest === request) {
            workspace.notify(error instanceof Error ? error.message : 'Could not check music files.');
          }
        });
    };
    checkFiles();
    window.addEventListener('focus', checkFiles);
    document.addEventListener('visibilitychange', checkFiles);
    return () => {
      active = false;
      window.removeEventListener('focus', checkFiles);
      document.removeEventListener('visibilitychange', checkFiles);
    };
  }, [desktopRuntime, workspace.loaded, nativeFilePathsKey]);

  useEffect(() => {
    if (!workspace.loaded) return;
    let active = true;
    setBrowserAudioHydrated(false);
    setDesktopAudioPresenceChecked(false);
    if (desktopRuntime) {
      const trackIds = workspace.tracks
        .filter(track => track.source === 'audio' && !track.filePath)
        .map(track => track.id);
      listDesktopImportedAudio(trackIds, invoke)
        .then(savedTrackIds => {
          if (!active) return;
          setDesktopImportedAudioIds(savedTrackIds);
          setDesktopAudioPresenceChecked(true);
        })
        .catch(error => {
          if (active) workspace.notify(error instanceof Error ? error.message : 'Could not check locally saved audio.');
        })
        .finally(() => {
          if (active) setBrowserAudioHydrated(true);
        });
      return () => { active = false; };
    }
    loadBrowserAudioFiles(workspace.tracks.map(track => track.id))
      .then(files => {
        if (!active) return;
        setBrowserAudioFiles(previous => new Map([...files, ...previous]));
        setBrowserAudioSavedTrackIds(previous => new Set([...previous, ...files.keys()]));
      })
      .catch(error => {
        if (active) workspace.notify(error instanceof Error ? error.message : 'Could not restore saved audio files.');
      })
      .finally(() => {
        if (active) setBrowserAudioHydrated(true);
      });
    return () => { active = false; };
  }, [workspace.loaded, desktopRuntime]);

  const missingDesktopAudioTrackIds = useMemo(() => {
    if (!desktopRuntime || !desktopAudioPresenceChecked) return new Set<string>();
    const missingTrackIds = findMissingDesktopImportedAudioTrackIds(
      workspace.tracks,
      desktopImportedAudioIds,
    );
    for (const trackId of failedDesktopAudioSaves.keys()) missingTrackIds.delete(trackId);
    return missingTrackIds;
  }, [
    desktopRuntime,
    desktopAudioPresenceChecked,
    workspace.tracks,
    desktopImportedAudioIds,
    failedDesktopAudioSaves,
  ]);

  const filteredTracks = useMemo(() => {
    const query = search.toLowerCase();
    return [...workspace.tracks].filter(track => {
      const matches = [track.title, track.artist, track.album, track.genre, track.fileName].join(' ').toLowerCase().includes(query);
      return matches && (filter === 'all' || (filter === 'unanalysed' && (track.bpm === null || track.key === null)) || (filter === 'high-energy' && (track.energy ?? 0) >= 8) || (filter === 'rated' && track.rating >= 4));
    }).sort((a, b) => sort === 'bpm' ? (b.bpm ?? 0) - (a.bpm ?? 0) : sort === 'year' ? (b.year ?? 0) - (a.year ?? 0) : a.title.localeCompare(b.title));
  }, [workspace.tracks, search, filter, sort]);
  const selected = workspace.tracks.find(track => track.id === selectedId) ?? filteredTracks[0];

  const loadDemo = () => {
    const loadedDemo = workspace.loadDemo();
    if (loadedDemo) {
      if (desktopRuntime) {
        const previousImportedTrackIds = workspace.tracks
          .filter(track => track.source === 'audio' && !track.filePath)
          .map(track => track.id);
        for (const trackId of failedDesktopAudioSaves.keys()) {
          releaseDesktopImportedAudioTrack(trackId);
        }
        void Promise.allSettled(previousImportedTrackIds.map(trackId =>
          invoke('delete_imported_audio', { trackId }),
        )).then(results => {
          const failedCount = results.filter(result => result.status === 'rejected').length;
          if (failedCount) workspace.notify(`${failedCount} saved audio file${failedCount === 1 ? '' : 's'} could not be removed.`);
        });
      }
      setFailedDesktopAudioSaves(new Map());
      setDesktopImportedAudioIds(new Set());
      setBrowserAudioFiles(new Map());
      setBrowserAudioSavedTrackIds(new Set());
      setFailedBrowserAudioSaves(new Map());
      if (!desktopRuntime) void clearBrowserAudioFiles().catch(error => {
        workspace.notify(error instanceof Error ? error.message : 'Could not clear stored audio.');
      });
    }
    return loadedDemo;
  };
  const retryDesktopAudioSave = async (trackId: string) => {
    const failedSave = failedDesktopAudioSaves.get(trackId);
    if (!failedSave || retryingDesktopAudioIdsRef.current.has(trackId)) return;
    retryingDesktopAudioIdsRef.current.add(trackId);
    setRetryingDesktopAudioIds(previous => new Set(previous).add(trackId));
    try {
      await saveDesktopImportedAudio(trackId, failedSave.fileName, failedSave.audio, invoke);
      setDesktopImportedAudioIds(previous => new Set(previous).add(trackId));
      setFailedDesktopAudioSaves(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Map(previous);
        next.delete(trackId);
        return next;
      });
      const title = workspace.tracks.find(track => track.id === trackId)?.title ?? failedSave.fileName;
      workspace.notify(`Audio for “${title}” was saved locally.`);
    } catch (error) {
      setFailedDesktopAudioSaves(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Map(previous);
        next.set(trackId, {
          ...failedSave,
          error: error instanceof Error ? error.message : 'Could not save audio locally.',
        });
        return next;
      });
    } finally {
      retryingDesktopAudioIdsRef.current.delete(trackId);
      setRetryingDesktopAudioIds(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Set(previous);
        next.delete(trackId);
        return next;
      });
    }
  };
  const restoreMissingDesktopAudio = async (trackId: string, file: File) => {
    const track = workspace.tracks.find(item => item.id === trackId);
    if (!desktopRuntime || !track || retryingDesktopAudioIdsRef.current.has(trackId)) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !['mp3', 'flac', 'wav', 'aif', 'aiff', 'm4a', 'mp4', 'ogg', 'opus'].includes(extension)) {
      workspace.notify('Choose a WAV, AIFF, MP3, FLAC, M4A, MP4, OGG, or Opus audio file.');
      return;
    }
    if (!file.size) {
      workspace.notify('The selected audio file is empty.');
      return;
    }
    retryingDesktopAudioIdsRef.current.add(trackId);
    setRetryingDesktopAudioIds(previous => new Set(previous).add(trackId));
    workspace.updateTrack(trackId, { fileName: file.name });
    try {
      await saveDesktopImportedAudio(trackId, file.name, file, invoke);
      setDesktopImportedAudioIds(previous => new Set(previous).add(trackId));
      setFailedDesktopAudioSaves(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Map(previous);
        next.delete(trackId);
        return next;
      });
      workspace.notify(`Audio restored for “${track.title}”. Playback and analysis are available again.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save audio locally.';
      setFailedDesktopAudioSaves(previous => new Map(previous).set(trackId, {
        fileName: file.name,
        audio: file,
        error: message,
      }));
      workspace.notify(`Audio for “${track.title}” is available until the app closes, but could not be saved locally. Retry save from the notice at the top.`);
    } finally {
      retryingDesktopAudioIdsRef.current.delete(trackId);
      setRetryingDesktopAudioIds(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Set(previous);
        next.delete(trackId);
        return next;
      });
    }
  };
  const chooseDesktopAudioRestore = (trackId: string) => {
    if (!missingDesktopAudioTrackIds.has(trackId)) return;
    restoreDesktopAudioTrackIdRef.current = trackId;
    if (restoreDesktopAudioInputRef.current) {
      restoreDesktopAudioInputRef.current.value = '';
      restoreDesktopAudioInputRef.current.click();
    }
  };
  const retryBrowserAudioSave = async (trackId: string) => {
    const failedSave = failedBrowserAudioSaves.get(trackId);
    if (!failedSave || retryingBrowserAudioIdsRef.current.has(trackId)) return;
    retryingBrowserAudioIdsRef.current.add(trackId);
    setRetryingBrowserAudioIds(previous => new Set(previous).add(trackId));
    try {
      await saveBrowserAudioFile(trackId, failedSave.audio);
      setBrowserAudioSavedTrackIds(previous => new Set(previous).add(trackId));
      setFailedBrowserAudioSaves(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Map(previous);
        next.delete(trackId);
        return next;
      });
      const title = workspace.tracks.find(track => track.id === trackId)?.title ?? failedSave.fileName;
      workspace.notify(`Audio for “${title}” is now saved in this browser.`);
    } catch (error) {
      setFailedBrowserAudioSaves(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Map(previous);
        next.set(trackId, {
          ...failedSave,
          error: error instanceof Error ? error.message : 'Could not save audio in this browser.',
        });
        return next;
      });
    } finally {
      retryingBrowserAudioIdsRef.current.delete(trackId);
      setRetryingBrowserAudioIds(previous => {
        if (!previous.has(trackId)) return previous;
        const next = new Set(previous);
        next.delete(trackId);
        return next;
      });
    }
  };
  const exportBackup = () => {
    downloadTextFile('drop-theory-pro-library-backup.json', JSON.stringify(createLibraryBackup({
      tracks: workspace.tracks,
      crates: workspace.crates,
    }), null, 2), 'application/json;charset=utf-8');
    workspace.notify('Metadata backup exported. Audio files and stem data are not included.');
  };
  const restoreBackup = async (file: File) => {
    try {
      const backup = parseLibraryBackup(await file.text());
      const result = mergeLibraryBackup({ tracks: workspace.tracks, crates: workspace.crates }, backup);
      workspace.setTracks(result.tracks);
      workspace.setCrates(result.crates);
      workspace.notify(`Backup merged: ${result.importedTracks} track${result.importedTracks === 1 ? '' : 's'} imported, ${result.duplicateTracks} duplicate${result.duplicateTracks === 1 ? '' : 's'} skipped, ${result.importedCrates} crate${result.importedCrates === 1 ? '' : 's'} imported.`);
    } catch (error) {
      workspace.notify(error instanceof Error ? error.message : 'Could not restore this library backup.');
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = '';
    }
  };

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    try {
      const incoming: Track[] = [];
      const importedPlaylists: Crate[] = [];
      const rekordboxTracks: Track[] = [];
      const audioFiles: File[] = [];
      let importedAudioTracks: Track[] = [];
      for (const file of Array.from(files)) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext === 'csv') incoming.push(...parseCsvTracks(await file.text()));
        else if (ext === 'm3u' || ext === 'm3u8') incoming.push(...parseM3uTracks(await file.text()));
        else if (ext === 'xml') {
          const imported = parseRekordboxXml(await file.text());
          rekordboxTracks.push(...imported.tracks);
          importedPlaylists.push(...imported.crates);
          incoming.push(...imported.tracks);
        }
        else if (file.type.startsWith('audio/') || ['mp3', 'wav', 'aiff', 'flac', 'm4a', 'ogg'].includes(ext ?? '')) audioFiles.push(file);
      }
      if (audioFiles.length) {
        importedAudioTracks = await importAudioFiles(audioFiles);
        incoming.push(...importedAudioTracks);
      }
      if (incoming.length) {
        const addedTracks = workspace.addTracks(incoming);
        if (importedPlaylists.length) {
          const allTracks = [...workspace.tracks, ...addedTracks];
          const normalizePath = (value: string | null | undefined) => value?.replace(/\\/g, '/').toLowerCase() ?? '';
          const byImportedId = new Map<string, string>();
          for (const source of rekordboxTracks) {
            const match = addedTracks.find(track => track.id === source.id)
              ?? allTracks.find(track => Boolean(source.filePath && normalizePath(track.filePath) === normalizePath(source.filePath)))
              ?? allTracks.find(track =>
                track.title.trim().toLowerCase() === source.title.trim().toLowerCase()
                && track.artist.trim().toLowerCase() === source.artist.trim().toLowerCase()
                && Boolean(source.title.trim()),
              );
            byImportedId.set(source.id, match?.id ?? source.id);
          }
          const playlists = importedPlaylists.map(crate => ({
            ...crate,
            trackIds: [...new Set(crate.trackIds.flatMap(id => byImportedId.has(id) ? [byImportedId.get(id)!] : []))],
          }));
          workspace.setCrates(previous => {
            const merged = [...previous];
            for (const imported of playlists) {
              const existing = merged.find(crate => crate.name.trim().toLowerCase() === imported.name.trim().toLowerCase());
              if (existing) {
                existing.trackIds = [...new Set([...existing.trackIds, ...imported.trackIds])];
                existing.updatedAt = now();
              } else {
                merged.push(imported);
              }
            }
            return merged;
          });
          workspace.notify(`Imported ${importedPlaylists.length} rekordbox playlist${importedPlaylists.length === 1 ? '' : 's'} from XML. Live rekordbox data was not changed.`);
        }
        const addedAudioAssignments = selectNewDesktopAudioAssignments(importedAudioTracks, audioFiles, addedTracks);
        if (addedAudioAssignments.length && desktopRuntime) {
          const savedIds: string[] = [];
          const failedSaves: Array<[string, { fileName: string; audio: Blob; error: string }]> = [];
          for (const { trackId, file } of addedAudioAssignments) {
            try {
              await saveDesktopImportedAudio(trackId, file.name, file, invoke);
              savedIds.push(trackId);
            } catch (error) {
              failedSaves.push([trackId, {
                fileName: file.name,
                audio: file,
                error: error instanceof Error ? error.message : 'Could not save audio locally.',
              }]);
            }
          }
          if (savedIds.length) {
            setDesktopImportedAudioIds(previous => new Set([...previous, ...savedIds]));
          }
          if (failedSaves.length) {
            setFailedDesktopAudioSaves(previous => new Map([...previous, ...failedSaves]));
            workspace.notify(`${failedSaves.length} audio file${failedSaves.length === 1 ? '' : 's'} could not be saved locally. Retry from the notice at the top of the workspace.`);
          }
        } else if (addedAudioAssignments.length) {
          setBrowserAudioFiles(previous => new Map([
            ...previous,
            ...addedAudioAssignments.map(({ trackId, file }) => [trackId, file] as const),
          ]));
          const results = await Promise.all(addedAudioAssignments.map(async ({ trackId, file }) => {
            try {
              await saveBrowserAudioFile(trackId, file);
              return { trackId, file, saved: true as const };
            } catch (error) {
              return {
                trackId,
                file,
                saved: false as const,
                error: error instanceof Error ? error.message : 'Could not save audio in this browser.',
              };
            }
          }));
          const savedIds = results.flatMap(result => result.saved ? [result.trackId] : []);
          if (savedIds.length) {
            setBrowserAudioSavedTrackIds(previous => new Set([...previous, ...savedIds]));
          }
          setFailedBrowserAudioSaves(previous => {
            const next = new Map(previous);
            for (const result of results) {
              if (result.saved) next.delete(result.trackId);
              else next.set(result.trackId, {
                fileName: result.file.name,
                audio: result.file,
                error: result.error,
              });
            }
            return next;
          });
          const failedCount = results.filter(result => !result.saved).length;
          if (failedCount) {
            workspace.notify(`${failedCount} audio file${failedCount === 1 ? '' : 's'} could not be saved. Retry before closing this page to keep them available.`);
          }
        }
      }
      else workspace.notify('No supported tracks were found in the selected files.');
    } catch (error) {
      workspace.notify(error instanceof Error ? error.message : 'Could not import the selected files.');
    } finally {
      setDialog(null);
    }
  };
  const scanNativeFolder = async (rescanSavedFolder = false) => {
    if (!desktopRuntime) {
      workspace.notify('Folder scanning is available only in the desktop app.');
      return;
    }
    try {
      let folder = rescanSavedFolder ? nativeFolder : null;
      if (!folder) {
        const selection = await openNativeDialog({ directory: true, multiple: false, title: 'Choose a music folder' });
        if (typeof selection !== 'string') return;
        folder = selection;
      }
      const result = await invoke<NativeScanResult>('scan_music_folder', { path: folder });
      await invoke('set_music_folder', { path: folder });
      setNativeFolder(folder);
      if (result.tracks.length) workspace.addTracks(result.tracks);
      else workspace.notify('No supported audio files were found in that folder.');
      const knownPaths = [...new Set([
        ...workspace.tracks.flatMap(track => track.filePath ? [track.filePath] : []),
        ...result.tracks.flatMap(track => track.filePath ? [track.filePath] : []),
      ])];
      const missingPaths = await invoke<string[]>('check_music_files', { paths: knownPaths });
      setMissingNativePaths(new Set(missingPaths));
      if (result.metadataWarnings > 0) {
        workspace.notify(`${result.scannedFiles} audio files scanned; ${result.metadataWarnings} need metadata review.`);
      }
      setDialog(null);
    } catch (error) {
      workspace.notify(error instanceof Error ? error.message : 'Could not scan the selected music folder.');
    }
  };
  const removeTrack = async (track: Track) => {
    if (removingTrackIdsRef.current.has(track.id)) return;
    if (!window.confirm(`Remove “${track.title}” from the library? This cannot be recovered unless you undo now.`)) return;
    removingTrackIdsRef.current.add(track.id);
    const snapshot = track;
    const browserAudioSnapshot = browserAudioFiles.get(track.id);
    let desktopAudioSnapshot: Blob | null = null;
    const previousCrateIds = workspace.crates.filter(crate => crate.trackIds.includes(track.id)).map(crate => crate.id);
    if (desktopRuntime) {
      try {
        if (track.source === 'audio' && !track.filePath) {
          desktopAudioSnapshot = await loadDesktopImportedAudioTrack(track.id, invoke);
        }
        await deleteDesktopImportedAudio(track.id, invoke);
      } catch {
        if (desktopAudioSnapshot) retainDesktopImportedAudioTrack(track.id, desktopAudioSnapshot);
        removingTrackIdsRef.current.delete(track.id);
        workspace.notify(desktopAudioSnapshot
          ? `Could not remove the saved audio for “${track.title}”. The track and audio are still available; try again.`
          : `Could not remove “${track.title}”. It remains in your library; try again.`);
        return;
      }
    }
    removingTrackIdsRef.current.delete(track.id);
    workspace.deleteTrack(track.id);
    setFailedDesktopAudioSaves(previous => {
      if (!previous.has(track.id)) return previous;
      const next = new Map(previous);
      next.delete(track.id);
      return next;
    });
    setBrowserAudioFiles(previous => {
      if (!previous.has(track.id)) return previous;
      const next = new Map(previous);
      next.delete(track.id);
      return next;
    });
    setFailedBrowserAudioSaves(previous => {
      if (!previous.has(track.id)) return previous;
      const next = new Map(previous);
      next.delete(track.id);
      return next;
    });
    setBrowserAudioSavedTrackIds(previous => {
      if (!previous.has(track.id)) return previous;
      const next = new Set(previous);
      next.delete(track.id);
      return next;
    });
    if (desktopRuntime) {
      setDesktopImportedAudioIds(previous => {
        if (!previous.has(track.id)) return previous;
        const next = new Set(previous);
        next.delete(track.id);
        return next;
      });
    }
    if (!desktopRuntime) void deleteBrowserAudioFile(track.id).catch(error => {
      workspace.notify(error instanceof Error ? error.message : 'Could not remove the stored audio file.');
    });
    setUndo({ message: `${track.title} removed`, action: () => {
      workspace.addTracks([snapshot]);
      const audioSnapshot = browserAudioSnapshot ?? desktopAudioSnapshot;
      if (audioSnapshot) {
        if (desktopRuntime) {
          void (async () => {
            try {
              await saveDesktopImportedAudio(track.id, snapshot.fileName ?? snapshot.title, audioSnapshot, invoke);
              setDesktopImportedAudioIds(previous => new Set(previous).add(track.id));
            } catch (error) {
              setDesktopImportedAudioIds(previous => new Set(previous).add(track.id));
              setFailedDesktopAudioSaves(previous => new Map(previous).set(track.id, {
                fileName: snapshot.fileName ?? snapshot.title,
                audio: audioSnapshot,
                error: error instanceof Error ? error.message : 'Could not restore the saved local audio.',
              }));
              workspace.notify(`Could not restore the saved audio for “${snapshot.title}”. The track remains playable; retry saving below.`);
            }
          })();
        } else {
          setBrowserAudioFiles(previous => new Map(previous).set(track.id, audioSnapshot));
          void saveBrowserAudioFile(track.id, audioSnapshot).then(() => {
            setBrowserAudioSavedTrackIds(previous => new Set(previous).add(track.id));
            setFailedBrowserAudioSaves(previous => {
              if (!previous.has(track.id)) return previous;
              const next = new Map(previous);
              next.delete(track.id);
              return next;
            });
          }).catch(error => {
            setFailedBrowserAudioSaves(previous => new Map(previous).set(track.id, {
              fileName: snapshot.fileName ?? snapshot.title,
              audio: audioSnapshot,
              error: error instanceof Error ? error.message : 'Could not restore the stored audio file.',
            }));
          });
        }
      }
      workspace.setCrates(previous => previous.map(crate => previousCrateIds.includes(crate.id) && !crate.trackIds.includes(track.id)
        ? { ...crate, trackIds: [...crate.trackIds, track.id], updatedAt: now() }
        : crate));
      setUndo(null);
    } });
    window.setTimeout(() => setUndo(null), 6000);
  };
  const nav = (next: Tab) => { setTab(next); setMobileNav(false); };
  const allWorkspaceNav = [
    ['overview', LayoutDashboard, 'Overview'],
    ['library', LibraryBig, 'Library'],
    ['decks', Disc3, 'Decks'],
    ['stem-studio', Split, 'Stem Studio'],
    ['crates', Layers3, 'Crates'],
    ['set-prep', ListMusic, 'Prep a set'],
    ['health', Activity, 'Library health'],
    ['licenses', ShieldCheck, 'Licensing & credits'],
  ] as const;
  const visibleWorkspaceNav = viewMode === 'beginner'
    ? allWorkspaceNav.filter(([id]) => ['overview', 'library', 'stem-studio', 'set-prep'].includes(id))
    : allWorkspaceNav;

  if (!workspace.loaded) return <LoadingShell />;
  return (
    <div className={`app-shell min-h-[100dvh] text-foreground ${desktopRuntime ? 'native-window-shell' : ''}`} data-view-mode={viewMode}>
      {desktopRuntime && <WindowChrome />}
      <div className={`grid md:grid-cols-[288px_minmax(0,1fr)] md:grid-rows-[96px_minmax(0,1fr)] ${desktopRuntime ? 'native-window-body' : 'min-h-[100dvh]'}`}>
        <aside className={`${mobileNav ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 flex w-[288px] shrink-0 flex-col overflow-y-auto bg-sidebar transition-transform duration-200 md:sticky md:top-0 md:col-start-1 md:row-span-2 md:h-[100dvh] md:self-start md:translate-x-0 ${desktopRuntime ? 'native-window-sidebar' : ''}`}>
          <div className="hidden h-[96px] items-center justify-center px-6 md:flex">
            <img src={dropTheoryProLogo} alt="Drop Theory Pro" className="block h-auto w-[220px] max-w-full" />
          </div>
          <div className="flex h-[76px] items-center justify-center px-6 md:hidden">
            <img src={dropTheoryProLogo} alt="Drop Theory Pro" className="block h-auto w-[220px] max-w-full" />
          </div>
          <div className="px-3 pt-7">
            <div className="mb-3 px-3 font-mono-ui text-[10px] uppercase tracking-[.18em] text-muted-foreground">Workspace</div>
            {visibleWorkspaceNav.map(([id, Icon, label]) => (
              <button key={id} onClick={() => nav(id)} data-testid={`nav-${id}`} aria-current={tab === id ? 'page' : undefined} className={`mb-1 flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[13px] transition-colors ${tab === id ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'}`}>
                <Icon size={16} strokeWidth={1.8} /><span>{label}</span>{id === 'health' && missingTempoKeyCount > 0 && <span className="ml-auto rounded-full bg-accent/15 px-1.5 py-0.5 font-mono-ui text-[9px] text-accent">{missingTempoKeyCount}</span>}
              </button>
            ))}
          </div>
          <div className="mt-auto p-4">
            <button onClick={() => nav('library')} className="mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[11px] text-sidebar-foreground/75 hover:bg-sidebar-accent">
              <span className="flex items-center gap-2"><Music2 size={14} /> Tracks</span><span className="font-mono-ui text-[10px] text-muted-foreground">{workspace.tracks.length}</span>
            </button>
            <button onClick={() => nav('crates')} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[11px] text-sidebar-foreground/75 hover:bg-sidebar-accent">
              <span className="flex items-center gap-2"><Layers3 size={14} /> Crates</span><span className="font-mono-ui text-[10px] text-muted-foreground">{workspace.crates.filter(crate => crate.kind !== 'set').length}</span>
            </button>
          </div>
        </aside>
        {mobileNav && <button aria-label="Close navigation" onClick={() => setMobileNav(false)} className="fixed inset-0 z-30 bg-black/40 md:hidden" />}
        <header className="min-w-0 bg-background md:col-start-2 md:row-start-1">
        <div className="flex min-h-[76px] min-w-0 items-center justify-between gap-2 px-3 py-3 sm:gap-3 sm:px-5 md:min-h-[96px] md:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-0">
            <button onClick={() => setMobileNav(true)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-secondary md:hidden" data-testid="button-open-navigation" aria-label="Open navigation"><Menu size={19} /></button>
            {tab === 'overview' && <div className="min-w-0">
              <h1 className="font-display text-[15px] font-semibold tracking-[-.04em] sm:text-[17px] md:text-2xl">Overview</h1>
              <p className="mt-0.5 max-w-[180px] text-[10px] leading-4 text-muted-foreground sm:max-w-none sm:text-[11px]">Your music library, crates, and track analysis.</p>
            </div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button onClick={() => setPaletteOpen(true)} data-testid="button-open-command-palette" aria-label="Search tracks and actions" className="hidden h-10 w-[180px] items-center gap-2 rounded-lg border border-border bg-card px-3 text-left text-[11px] text-muted-foreground hover:border-primary/50 sm:flex lg:w-[220px] 2xl:w-[270px]">
              <Search size={14} /><span className="flex-1">Search tracks and actions</span><kbd className="rounded border border-border px-1.5 py-0.5 font-mono-ui text-[9px]">Ctrl K</kbd>
            </button>
            <label className="hidden items-center gap-2 text-[10px] text-muted-foreground lg:flex">
              <span>Mode</span>
              <select value={viewMode} onChange={event => setViewMode(event.target.value as ViewMode)} data-testid="select-view-mode" className="h-8 rounded-md border border-border bg-background px-2 text-[10px] text-foreground">
                <option value="beginner">Beginner</option><option value="standard">Standard</option><option value="pro">Pro</option>
              </select>
            </label>
            <button onClick={() => setPaletteOpen(true)} data-testid="button-open-command-palette-mobile" aria-label="Search tracks and actions" className="flex h-10 w-10 items-center justify-center rounded-lg border border-border text-muted-foreground hover:border-primary/50 hover:text-foreground sm:hidden"><Search size={15} /></button>
            <span className="hidden items-center gap-2 font-mono-ui text-[10px] text-muted-foreground xl:flex"><span className="h-1.5 w-1.5 rounded-full bg-primary" />Ready</span>
            <button onClick={() => setDialog('import')} data-testid="button-import-header" className="flex min-h-11 items-center gap-2 rounded-xl bg-primary px-3 text-[12px] font-bold text-primary-foreground transition-colors hover:bg-primary/90 sm:px-4"><Upload size={14} /> Import</button>
          </div>
        </div>
      </header>
        <main className="min-w-0 md:col-start-2 md:row-start-2">
          {!desktopRuntime && (
            <div role="status" data-testid="browser-local-mode-notice" className="border-b border-border bg-card/60 px-5 py-3 text-[11px] leading-5 text-muted-foreground sm:px-8">
              Browser-local workspace: your library and imported audio stay in this browser and are not synced online. Native folder scanning, native audio output, and offline stem separation require the desktop app.
            </div>
          )}
          {workspace.storageError && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-5 py-3 text-[11px] text-destructive sm:px-8">Library storage is unavailable: {workspace.storageError}. Changes may not persist after this tab closes.</div>}
          {!desktopRuntime && failedBrowserAudioSaves.size > 0 && <section role="alert" aria-label="Browser audio saves needing retry" data-testid="failed-browser-audio-saves" className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 text-[11px] text-foreground sm:px-8">
            <p className="font-semibold">Some imported audio is available only until this page closes.</p>
            <p className="mt-1 text-muted-foreground">The original files are still playable in this session. Retry saving them to IndexedDB to keep the audio available after reload.</p>
            <ul className="mt-2 space-y-2">
              {Array.from(failedBrowserAudioSaves, ([trackId, failedSave]) => {
                const track = workspace.tracks.find(item => item.id === trackId);
                if (!track) return null;
                const retrying = retryingBrowserAudioIds.has(trackId);
                return <li key={trackId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1">{track.title} — {failedSave.error}</span>
                  <button type="button" onClick={() => void retryBrowserAudioSave(trackId)} disabled={retrying} data-testid={`button-retry-browser-audio-${trackId}`} className="rounded-md border border-border bg-card px-3 py-1.5 font-semibold text-primary hover:border-primary/50 disabled:cursor-wait disabled:opacity-60">
                    {retrying ? 'Saving…' : 'Retry save'}
                  </button>
                </li>;
              })}
            </ul>
          </section>}
          {desktopRuntime && failedDesktopAudioSaves.size > 0 && <section role="alert" aria-label="Desktop audio saves needing retry" data-testid="failed-desktop-audio-saves" className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 text-[11px] text-foreground sm:px-8">
            <p className="font-semibold">Some imported audio could not be saved on this device.</p>
            <p className="mt-1 text-muted-foreground">The original files are held in memory until Drop Theory Pro closes. Retry here without importing the tracks again.</p>
            <ul className="mt-2 space-y-2">
              {Array.from(failedDesktopAudioSaves, ([trackId, failedSave]) => {
                const track = workspace.tracks.find(item => item.id === trackId);
                if (!track) return null;
                const retrying = retryingDesktopAudioIds.has(trackId);
                return <li key={trackId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1">{track.title} — {failedSave.error}</span>
                  <button type="button" onClick={() => void retryDesktopAudioSave(trackId)} disabled={retrying} data-testid={`button-retry-desktop-audio-${trackId}`} className="rounded-md border border-border bg-card px-3 py-1.5 font-semibold text-primary hover:border-primary/50 disabled:cursor-wait disabled:opacity-60">
                    {retrying ? 'Saving…' : 'Retry save'}
                  </button>
                </li>;
              })}
            </ul>
          </section>}
          <div className="mx-auto max-w-[1500px] p-5 sm:p-8">
            <div className={tab === 'decks' ? '' : 'hidden'}>
              <DecksWorkspace tracks={workspace.tracks} browserAudioFiles={browserAudioFiles} importedAudioTrackIds={desktopImportedAudioIds} missingNativePaths={missingNativePaths} desktopRuntime={desktopRuntime} audioHydrated={browserAudioHydrated} onImport={() => setDialog('import')} />
            </div>
            <div className={tab === 'decks' ? 'hidden' : ''}>
              {tab === 'overview' && <Overview tracks={workspace.tracks} crates={workspace.crates.filter(crate => crate.kind !== 'set')} onDemo={loadDemo} onImport={() => setDialog('import')} onNavigate={nav} />}
              {tab === 'stem-studio' && <StemStudioWorkspace tracks={workspace.tracks} importedAudioTrackIds={desktopImportedAudioIds} missingNativePaths={missingNativePaths} desktopRuntime={desktopRuntime} onImport={() => setDialog('import')} />}
              {tab === 'library' && <Library tracks={filteredTracks} allTracks={workspace.tracks} missingNativePaths={missingNativePaths} missingDesktopAudioTrackIds={missingDesktopAudioTrackIds} restoringDesktopAudioIds={retryingDesktopAudioIds} browserAudioFiles={browserAudioFiles} browserAudioSavedTrackIds={browserAudioSavedTrackIds} browserAudioHydrated={browserAudioHydrated} browserRuntime={!desktopRuntime} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} selected={selected} onSelect={setSelectedId} onEdit={track => { setEditing(track); setDialog('edit'); }} onDelete={removeTrack} onImport={() => setDialog('import')} onRestoreManagedAudio={chooseDesktopAudioRestore} onRescanFolder={desktopRuntime && nativeFolder ? () => scanNativeFolder(true) : undefined} onExportBackup={exportBackup} onRestoreBackup={() => backupInputRef.current?.click()} onExportRekordbox={() => {
                const manualCrates = workspace.crates.filter(crate => crate.kind !== 'set');
                if (!window.confirm(`Create a rekordbox XML file with ${workspace.tracks.length} tracks and ${manualCrates.length} playlists? This exports metadata only and does not modify the live rekordbox database. Hot cues, memory cues, and beatgrid details are not included.`)) return;
                downloadTextFile('drop-theory-pro-rekordbox.xml', exportRekordboxXml(workspace.tracks, manualCrates), 'application/xml;charset=utf-8');
                workspace.notify('Rekordbox XML exported. Review the file and import it in rekordbox; cue and grid details are not included.');
              }} />}
              {tab === 'crates' && <Crates tracks={workspace.tracks} crates={workspace.crates.filter(crate => crate.kind !== 'set')} setCrates={workspace.setCrates} onSelectTrack={id => { setSelectedId(id); setTab('library'); }} onUndo={setUndo} />}
              {tab === 'set-prep' && <SetPlanner tracks={workspace.tracks} savedSets={workspace.crates.filter(crate => crate.kind === 'set')} onSaveSet={saved => workspace.setCrates(previous => previous.some(crate => crate.id === saved.id) ? previous.map(crate => crate.id === saved.id ? saved : crate) : [...previous, saved])} onDeleteSet={id => {
                const saved = workspace.crates.find(crate => crate.id === id);
                if (!saved) return;
                workspace.setCrates(previous => previous.filter(crate => crate.id !== id));
                setUndo({ message: `${saved.name} removed`, action: () => { workspace.setCrates(previous => [...previous, saved]); setUndo(null); } });
                window.setTimeout(() => setUndo(null), 6000);
              }} onSelectTrack={id => { setSelectedId(id); setTab('library'); }} onImport={() => setDialog('import')} />}
              {tab === 'health' && <Health tracks={workspace.tracks} browserAudioFiles={browserAudioFiles} importedAudioTrackIds={desktopImportedAudioIds} missingNativePaths={missingNativePaths} desktopRuntime={desktopRuntime} onUpdate={workspace.updateTrack} onEdit={track => { setEditing(track); setDialog('edit'); }} onNavigate={nav} />}
              {tab === 'licenses' && <LicensesPage />}
            </div>
          </div>
        </main>
      </div>
      {workspace.notice && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-primary/30 bg-card px-4 py-3 text-[12px] text-card-foreground shadow-xl">{workspace.notice}</div>}
      {undo && <div className="fixed bottom-5 left-5 z-50 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-[12px] shadow-xl"><span>{undo.message}</span><button onClick={undo.action} data-testid="button-undo" className="flex items-center gap-1.5 font-bold text-primary"><RotateCcw size={13} /> Undo</button></div>}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNavigate={next => { nav(next); setPaletteOpen(false); }} onImport={() => setDialog('import')} onDemo={loadDemo} onSearch={query => { setSearch(query); setFilter('all'); nav('library'); }} />
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} onFiles={importFiles} onDemo={() => { if (loadDemo()) setDialog(null); }} onChooseFolder={desktopRuntime ? () => scanNativeFolder(false) : undefined} onRescanFolder={desktopRuntime && nativeFolder ? () => scanNativeFolder(true) : undefined} nativeFolder={nativeFolder} />}
      {dialog === 'edit' && editing && <EditDialog track={editing} onClose={() => setDialog(null)} onSave={patch => { workspace.updateTrack(editing.id, patch); setDialog(null); workspace.notify('Track metadata saved.'); }} />}
      <input ref={restoreDesktopAudioInputRef} type="file" accept="audio/*,.mp3,.wav,.aiff,.aif,.flac,.m4a,.mp4,.ogg,.opus" className="hidden" data-testid="input-restore-desktop-audio" onChange={event => {
        const file = event.currentTarget.files?.[0];
        const trackId = restoreDesktopAudioTrackIdRef.current;
        event.currentTarget.value = '';
        restoreDesktopAudioTrackIdRef.current = null;
        if (file && trackId) void restoreMissingDesktopAudio(trackId, file);
      }} />
      <input ref={backupInputRef} type="file" accept="application/json,.json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void restoreBackup(file); }} />
    </div>
  );
}

function LoadingShell() {
  return <div className="app-shell min-h-[100dvh] p-8"><div className="mx-auto max-w-[1200px] space-y-5"><div className="h-8 w-48 animate-pulse rounded bg-secondary" /><div className="h-36 animate-pulse rounded-xl bg-secondary" /><div className="h-72 animate-pulse rounded-xl bg-secondary" /></div></div>;
}

function Overview({ tracks, crates, onDemo, onImport, onNavigate }: { tracks: Track[]; crates: Crate[]; onDemo: () => void; onImport: () => void; onNavigate: (tab: Tab) => void }) {
  const tagged = tracks.filter(track => track.bpm !== null && track.key !== null).length;
  const coverage = tracks.length ? Math.round((tagged / tracks.length) * 100) : 0;
  const needsAnalysis = tracks.filter(track => track.bpm === null || track.key === null).length;
  const analyzed = tracks.filter(track => track.analyzed).length;
  const totalSeconds = tracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  const recent = [...tracks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const recentCrates = [...crates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const tempoRanges = [
    { label: 'Under 100', min: 0, max: 100 },
    { label: '100–119', min: 100, max: 120 },
    { label: '120–139', min: 120, max: 140 },
    { label: '140+', min: 140, max: Number.POSITIVE_INFINITY },
  ].map(range => ({
    ...range,
    count: tracks.filter(track => track.bpm !== null && track.bpm >= range.min && track.bpm < range.max).length,
  }));
  const tempoCount = tempoRanges.reduce((sum, range) => sum + range.count, 0);
  const largestTempoRange = Math.max(1, ...tempoRanges.map(range => range.count));
  const crateTrackCount = new Set(crates.flatMap(crate => crate.trackIds)).size;

  return (
    <div className="reveal space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Tracks" value={tracks.length.toLocaleString()} detail="in your library" accent="teal" icon={<Music2 size={16} />} />
        <Metric label="Playing time" value={formatCatalogDuration(totalSeconds)} detail="total track duration" accent="blue" icon={<Disc3 size={16} />} />
        <Metric label="BPM and key" value={`${coverage}%`} detail={tracks.length ? `${tagged} of ${tracks.length} tracks` : 'No tracks yet'} accent="amber" icon={<Activity size={16} />} />
        <Metric label="Crates" value={crates.length.toString()} detail={`${crateTrackCount} track${crateTrackCount === 1 ? '' : 's'} in crates`} accent="teal" icon={<Layers3 size={16} />} />
      </div>

      {needsAnalysis > 0 && <button onClick={() => onNavigate('health')} data-testid="button-next-best-action" className="flex w-full items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-left hover:border-accent/50">
        <span><span className="block text-[12px] font-semibold text-foreground">Tracks need metadata review</span><span className="mt-1 block text-[11px] text-muted-foreground">{needsAnalysis} track{needsAnalysis === 1 ? '' : 's'} missing BPM or key values.</span></span>
        <span className="shrink-0 text-[11px] font-semibold text-accent">Review</span>
      </button>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
        <section className="panel-line overflow-hidden rounded-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-5">
            <div><h2 className="text-[14px] font-semibold">Tempo ranges</h2><p className="mt-1 text-[11px] text-muted-foreground">{tempoCount} tracks with BPM data</p></div>
            <Activity size={16} className="text-primary" />
          </div>
          {tempoCount ? <div className="grid min-h-[210px] grid-cols-4 gap-3 px-4 pb-4 pt-5 sm:gap-5 sm:px-6">
            {tempoRanges.map(range => <div key={range.label} className="flex min-w-0 flex-col items-center justify-end gap-2">
              <span className="font-mono-ui text-[10px] text-muted-foreground">{range.count}</span>
              <div className="flex h-32 w-full items-end justify-center rounded-t-md bg-secondary/60">
                <div className="w-full max-w-14 rounded-t-md bg-primary/80 transition-all" style={{ height: `${range.count ? Math.max(8, (range.count / largestTempoRange) * 100) : 0}%` }} />
              </div>
              <span className="text-center text-[9px] text-muted-foreground sm:text-[10px]">{range.label}</span>
            </div>)}
          </div> : <div className="flex min-h-[210px] items-center justify-center px-6 text-center text-[11px] text-muted-foreground">
            {tracks.length ? 'BPM values will appear here after tracks are analyzed or updated.' : 'Import tracks to see your tempo distribution.'}
          </div>}
        </section>

        <section className="panel-line overflow-hidden rounded-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-5">
            <div><h2 className="text-[14px] font-semibold">Your crates</h2><p className="mt-1 text-[11px] text-muted-foreground">Track collections for your sets</p></div>
            <button onClick={() => onNavigate('crates')} data-testid="button-open-crates" className="text-[11px] font-semibold text-primary hover:underline">Manage crates</button>
          </div>
          {recentCrates.length ? <div className="divide-y divide-border/70">
            {recentCrates.map(crate => <button key={crate.id} onClick={() => onNavigate('crates')} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-secondary/50 sm:px-5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: crate.color }} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{crate.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{crate.trackIds.length} tracks</span>
            </button>)}
          </div> : <div className="flex min-h-[210px] flex-col items-center justify-center px-6 text-center">
            <Layers3 size={19} className="mb-2 text-muted-foreground" />
            <p className="text-[11px] font-medium">No crates yet</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Create a crate to organize tracks for a set.</p>
            <button onClick={() => onNavigate('crates')} className="mt-3 text-[11px] font-semibold text-primary hover:underline">Create a crate</button>
          </div>}
        </section>
      </div>

      <section className="panel-line overflow-hidden rounded-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-5">
          <div><h2 className="text-[14px] font-semibold">Recently added</h2><p className="mt-1 text-[11px] text-muted-foreground">{tracks.length ? `${analyzed} of ${tracks.length} tracks analyzed` : 'No track history yet'}</p></div>
          <button onClick={() => onNavigate('library')} data-testid="button-view-library" className="text-[11px] font-semibold text-primary hover:underline">Open library</button>
        </div>
        {recent.length ? <div>{recent.map((track, index) => <TrackListRow key={track.id} track={track} index={index} />)}</div> : <div className="flex flex-col items-center justify-center px-5 py-9 text-center">
          <Music2 size={20} className="mb-2 text-muted-foreground" />
          <p className="text-[12px] font-medium">No tracks in your library</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Import audio or a playlist to get started.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button onClick={onImport} data-testid="button-import-empty" className="rounded-lg bg-primary px-3 py-2 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90">Import tracks</button>
            <button onClick={onDemo} data-testid="button-load-demo" className="rounded-lg border border-border px-3 py-2 text-[11px] font-semibold hover:border-primary/50">Load sample tracks</button>
          </div>
        </div>}
      </section>
    </div>
  );
}

function formatCatalogDuration(totalSeconds: number) {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} hr ${minutes} min` : `${totalMinutes} min`;
}

function Metric({ label, value, detail, accent, icon }: { label: string; value: string; detail: string; accent: string; icon?: ReactNode }) {
  const accentStyle = accent === 'amber' ? 'bg-accent/10 text-accent' : accent === 'blue' ? 'bg-chart-3/10 text-chart-3' : 'bg-primary/10 text-primary';
  return <div className="panel-line metric-card rounded-xl p-4 sm:p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      {icon && <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${accentStyle}`}>{icon}</span>}
    </div>
    <div className="mt-3 font-mono-ui text-2xl text-foreground sm:text-3xl">{value}</div>
    <div className="mt-1 text-[10px] text-muted-foreground">{detail}</div>
  </div>;
}

function TrackListRow({ track, index, onClick }: { track: Track; index: number; onClick?: () => void }) {
  return <div onClick={onClick} data-testid={`row-recent-track-${track.id}`} className={`data-row flex items-center gap-3 border-b border-border/70 px-4 py-3.5 last:border-0 sm:px-5 ${onClick ? 'cursor-pointer' : ''}`}><span className="w-4 font-mono-ui text-[10px] text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-secondary text-primary"><Music2 size={14} /></span><div className="min-w-0 flex-1"><div className="truncate text-[12px] font-semibold">{track.title}</div><div className="truncate text-[10px] text-muted-foreground">{track.artist} · {track.album}</div></div><span className="hidden font-mono-ui text-[10px] text-muted-foreground sm:block">{track.bpm ?? '—'} BPM</span><span className="font-mono-ui text-[10px] text-muted-foreground">{fmtTime(track.durationSeconds)}</span></div>;
}

function Library({ tracks, allTracks, missingNativePaths, missingDesktopAudioTrackIds, restoringDesktopAudioIds, browserAudioFiles, browserAudioSavedTrackIds, browserAudioHydrated, browserRuntime, search, setSearch, filter, setFilter, sort, setSort, selected, onSelect, onEdit, onDelete, onImport, onRestoreManagedAudio, onRescanFolder, onExportBackup, onRestoreBackup, onExportRekordbox }: { tracks: Track[]; allTracks: Track[]; missingNativePaths: ReadonlySet<string>; missingDesktopAudioTrackIds: ReadonlySet<string>; restoringDesktopAudioIds: ReadonlySet<string>; browserAudioFiles: ReadonlyMap<string, Blob>; browserAudioSavedTrackIds: ReadonlySet<string>; browserAudioHydrated: boolean; browserRuntime: boolean; search: string; setSearch: (v: string) => void; filter: string; setFilter: (v: string) => void; sort: 'title' | 'bpm' | 'year'; setSort: (v: 'title' | 'bpm' | 'year') => void; selected?: Track; onSelect: (id: string) => void; onEdit: (track: Track) => void; onDelete: (track: Track) => void; onImport: () => void; onRestoreManagedAudio: (trackId: string) => void; onRescanFolder?: () => void; onExportBackup: () => void; onRestoreBackup: () => void; onExportRekordbox: () => void }) {
  const exportCsv = () => downloadTextFile('drop-theory-pro-library.csv', exportTracksCsv(allTracks), 'text/csv;charset=utf-8');
  const exportM3u = () => downloadTextFile('drop-theory-pro-library.m3u8', exportTracksM3u(allTracks), 'audio/x-mpegurl;charset=utf-8');
  return (
    <div className="reveal space-y-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.2em] text-primary">Track catalog · {allTracks.length} tracks</div>
          <h1 className="font-display text-4xl font-semibold tracking-[-.055em]">Library</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={onExportBackup} data-testid="button-export-backup" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2.5 text-[11px] font-bold hover:border-primary/50"><Download size={13} /> Backup</button>
          <button onClick={onRestoreBackup} data-testid="button-restore-backup" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2.5 text-[11px] font-bold hover:border-primary/50"><Upload size={13} /> Restore</button>
          <button onClick={onExportRekordbox} disabled={!allTracks.length} data-testid="button-export-rekordbox-xml" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2.5 text-[11px] font-bold hover:border-primary/50 disabled:opacity-40"><Download size={13} /> rekordbox XML</button>
          <button onClick={exportCsv} disabled={!allTracks.length} data-testid="button-export-csv" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2.5 text-[11px] font-bold hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40"><Download size={13} /> CSV</button>
          <button onClick={exportM3u} disabled={!allTracks.length} data-testid="button-export-m3u" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2.5 text-[11px] font-bold hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40"><ListMusic size={13} /> M3U</button>
          <button onClick={onImport} data-testid="button-import-library" className="flex items-center gap-2 rounded-md bg-primary px-3 py-2.5 text-[12px] font-bold text-primary-foreground"><Upload size={14} /> Import files</button>
        </div>
      </div>
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[10px] leading-4 text-muted-foreground">Backups restore library metadata, analysis, crates, and file references only. Source audio, external files, ONNX models, and stem cache are never included.</div>
      <div className="panel-line flex flex-col gap-3 rounded-xl p-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} data-testid="input-search-tracks" placeholder="Search title, artist, album..." className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-[12px] outline-none placeholder:text-muted-foreground focus:border-primary" />
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Filter size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <select value={filter} onChange={e => setFilter(e.target.value)} data-testid="select-track-filter" className="h-9 appearance-none rounded-md border border-border bg-background pl-8 pr-8 text-[11px] outline-none">
              <option value="all">All tracks</option><option value="unanalysed">Needs analysis</option><option value="high-energy">High energy</option><option value="rated">Rated 4+</option>
            </select>
            <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          </div>
          <div className="relative">
            <ArrowDownUp size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <select value={sort} onChange={e => setSort(e.target.value as 'title' | 'bpm' | 'year')} data-testid="select-track-sort" className="h-9 appearance-none rounded-md border border-border bg-background pl-8 pr-8 text-[11px] outline-none">
              <option value="title">Title</option><option value="bpm">BPM</option><option value="year">Year</option>
            </select>
            <ChevronDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="panel-line overflow-hidden rounded-xl">
          <div className="hidden grid-cols-[42px_minmax(170px,1.5fr)_minmax(120px,1fr)_130px_72px_68px] gap-3 border-b border-border px-5 py-3 font-mono-ui text-[9px] uppercase tracking-[.13em] text-muted-foreground sm:grid">
            <span>#</span><span>Track</span><span>Release</span><span>BPM / key · Camelot</span><span>Energy</span><span />
          </div>
          {tracks.length ? tracks.map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              index={index}
              active={track.id === selected?.id}
              missing={Boolean(track.filePath && missingNativePaths.has(track.filePath))}
              missingManagedAudio={missingDesktopAudioTrackIds.has(track.id)}
              browserAudioStatus={
                browserRuntime && browserAudioHydrated && track.source === 'audio' && !track.filePath
                  ? browserAudioSavedTrackIds.has(track.id)
                    ? 'saved'
                    : browserAudioFiles.has(track.id)
                      ? 'session-only'
                      : 'unavailable'
                  : undefined
              }
              onSelect={() => onSelect(track.id)}
              onEdit={() => onEdit(track)}
              onDelete={() => onDelete(track)}
            />
          )) : (
            <div className="p-12 text-center">
              <Search className="mx-auto mb-3 text-muted-foreground" size={22} />
              <p className="text-sm font-semibold">No tracks match</p>
              <p className="mt-1 text-xs text-muted-foreground">Try a different search or filter.</p>
            </div>
          )}
        </section>
        <TrackInspector
          track={selected}
          missing={Boolean(selected?.filePath && missingNativePaths.has(selected.filePath))}
          missingManagedAudio={Boolean(selected && missingDesktopAudioTrackIds.has(selected.id))}
          restoringManagedAudio={Boolean(selected && restoringDesktopAudioIds.has(selected.id))}
          onEdit={onEdit}
          onRestoreManagedAudio={onRestoreManagedAudio}
          onRescanFolder={onRescanFolder}
        />
      </div>
    </div>
  );
}

function TrackRow({ track, index, active, missing, missingManagedAudio, browserAudioStatus, onSelect, onEdit, onDelete }: { track: Track; index: number; active: boolean; missing: boolean; missingManagedAudio: boolean; browserAudioStatus?: 'saved' | 'session-only' | 'unavailable'; onSelect: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <div onClick={onSelect} data-testid={`row-track-${track.id}`} className={`data-row group grid cursor-pointer grid-cols-[30px_minmax(0,1fr)_72px] items-center gap-3 border-b border-border/70 px-4 py-3 sm:grid-cols-[42px_minmax(170px,1.5fr)_minmax(120px,1fr)_130px_72px_68px] sm:px-5 ${active ? 'selected' : ''}`}>
      <span className="font-mono-ui text-[10px] text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-secondary text-primary"><Music2 size={14} /></span>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold">{track.title}</div>
          <div className="truncate text-[10px] text-muted-foreground">{track.artist}</div>
          {missing && <span className="mt-1 inline-block rounded bg-destructive/10 px-1.5 py-0.5 font-mono-ui text-[8px] uppercase tracking-wide text-destructive">Source unavailable</span>}
          {missingManagedAudio && <span className="mt-1 inline-block rounded bg-destructive/10 px-1.5 py-0.5 font-mono-ui text-[8px] uppercase tracking-wide text-destructive">Saved audio missing</span>}
          {browserAudioStatus && <span className={`mt-1 inline-block rounded px-1.5 py-0.5 font-mono-ui text-[8px] uppercase tracking-wide ${browserAudioStatus === 'unavailable' ? 'bg-destructive/10 text-destructive' : browserAudioStatus === 'session-only' ? 'bg-amber-500/10 text-amber-700' : 'bg-primary/10 text-primary'}`}>
            {browserAudioStatus === 'saved' ? 'Audio saved in IndexedDB' : browserAudioStatus === 'session-only' ? 'Audio only in this session' : 'Audio unavailable'}
          </span>}
        </div>
      </div>
      <div className="hidden min-w-0 sm:block">
        <div className="truncate text-[11px]">{track.album}</div>
        <div className="truncate text-[10px] text-muted-foreground">{track.genre}</div>
      </div>
      <div className="hidden min-w-0 font-mono-ui sm:block">
        <div className="text-[10px]">{track.bpm ?? '—'} BPM</div>
        <div className="truncate text-[9px] text-muted-foreground">{formatKeyWithCamelot(track.key) ?? 'Key unknown'}</div>
      </div>
      <div className="hidden sm:block">
        <div className="flex gap-0.5">{[1, 2, 3, 4, 5].map(n => <span key={n} className={`h-1.5 w-1.5 rounded-full ${n <= Math.round((track.energy ?? 0) / 2) ? 'bg-accent' : 'bg-secondary'}`} />)}</div>
        <div className="mt-1 font-mono-ui text-[9px] text-muted-foreground">{track.energy ?? '—'}/10</div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <span className="hidden font-mono-ui text-[10px] text-muted-foreground lg:block">{fmtTime(track.durationSeconds)}</span>
        <button onClick={e => { e.stopPropagation(); onEdit(); }} aria-label={`Edit ${track.title}`} data-testid={`button-edit-track-${track.id}`} className="rounded p-1.5 text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground group-hover:opacity-100"><Pencil size={13} /></button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} aria-label={`Delete ${track.title}`} data-testid={`button-delete-track-${track.id}`} className="rounded p-1.5 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

function TrackInspector({ track, missing, missingManagedAudio, restoringManagedAudio, onEdit, onRestoreManagedAudio, onRescanFolder }: { track?: Track; missing: boolean; missingManagedAudio: boolean; restoringManagedAudio: boolean; onEdit: (track: Track) => void; onRestoreManagedAudio: (trackId: string) => void; onRescanFolder?: () => void }) {
  if (!track) return <div className="panel-line flex min-h-[260px] items-center justify-center rounded-xl p-5 text-center text-xs text-muted-foreground">Select a track to inspect it.</div>;
  const hasTempoKey = track.bpm !== null && track.key !== null;
  return <aside className="panel-line h-fit rounded-xl p-5">
    <div className="mb-5 flex items-start justify-between"><div><div className="mb-1 font-mono-ui text-[9px] uppercase tracking-[.16em] text-primary">Selected track</div><h2 className="font-display text-2xl font-semibold tracking-[-.04em]">{track.title}</h2><p className="mt-1 text-[11px] text-muted-foreground">{track.artist}</p></div><button onClick={() => onEdit(track)} data-testid="button-edit-selected-track" className="rounded-md border border-border p-2 text-muted-foreground hover:text-foreground"><Pencil size={14} /></button></div>
    <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border"><InspectorCell label="BPM" value={track.bpm?.toString() ?? '—'} /><InspectorCell label="Key · Camelot" value={formatKeyWithCamelot(track.key) ?? '—'} /><InspectorCell label="Length" value={fmtTime(track.durationSeconds)} /><InspectorCell label="Year" value={track.year?.toString() ?? '—'} /></div>
    {missing && <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3"><p className="text-[10px] font-semibold text-destructive">Audio file unavailable</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">Library metadata is preserved. Reconnect the drive, then rescan its saved folder.</p>{onRescanFolder && <button onClick={onRescanFolder} className="mt-2 rounded border border-destructive/30 px-2 py-1 text-[9px] font-bold text-destructive hover:bg-destructive/10">Rescan saved folder</button>}</div>}
    {missingManagedAudio && <div role="alert" data-testid={`missing-managed-audio-${track.id}`} className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3"><p className="text-[10px] font-semibold text-destructive">Saved audio is missing</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">Playback and analysis are unavailable until audio is restored. Re-import the audio file to restore this track without adding a duplicate.</p><button type="button" onClick={() => onRestoreManagedAudio(track.id)} disabled={restoringManagedAudio} data-testid={`button-restore-managed-audio-${track.id}`} className="mt-2 flex items-center gap-1.5 rounded border border-destructive/30 px-2 py-1.5 text-[9px] font-bold text-destructive hover:bg-destructive/10 disabled:cursor-wait disabled:opacity-60"><Upload size={12} /> {restoringManagedAudio ? 'Saving…' : 'Re-import audio'}</button></div>}
    <div className="space-y-3 text-[11px]"><div className="flex justify-between"><span className="text-muted-foreground">Source</span><span className="capitalize">{track.source === 'audio' ? 'Audio file' : `${track.source} metadata`}</span></div><div className="flex justify-between"><span className="text-muted-foreground">File</span><span className="max-w-[150px] truncate">{track.fileName ?? '—'}</span></div><div className="flex justify-between"><span className="text-muted-foreground">BPM and key values</span><span className={hasTempoKey ? 'text-primary' : 'text-accent'}>{hasTempoKey ? 'Metadata present' : 'Missing'}</span></div></div>
  </aside>;
}
function InspectorCell({ label, value }: { label: string; value: string }) { return <div className="bg-card p-3"><div className="mb-1 font-mono-ui text-[9px] uppercase text-muted-foreground">{label}</div><div className="font-mono-ui text-sm">{value}</div></div>; }

function Crates({ tracks, crates, setCrates, onSelectTrack, onUndo }: { tracks: Track[]; crates: Crate[]; setCrates: (value: Crate[] | ((previous: Crate[]) => Crate[])) => void; onSelectTrack: (id: string) => void; onUndo: (value: { message: string; action: () => void } | null) => void }) {
  const [activeId, setActiveId] = useState(crates[0]?.id);
  const [editing, setEditing] = useState<Crate | null>(null);
  const [newName, setNewName] = useState('');
  const [addTracksOpen, setAddTracksOpen] = useState(false);
  const [trackSearch, setTrackSearch] = useState('');
  const active = crates.find(crate => crate.id === activeId) ?? crates[0];
  const members = active
    ? tracks.filter(track => active.trackIds.includes(track.id)).sort((a, b) => a.title.localeCompare(b.title))
    : [];
  const availableTracks = active
    ? tracks
      .filter(track => !active.trackIds.includes(track.id))
      .filter(track => [track.title, track.artist, track.album].join(' ').toLowerCase().includes(trackSearch.toLowerCase()))
      .sort((a, b) => a.title.localeCompare(b.title))
    : [];

  const create = () => {
    if (!newName.trim()) return;
    const crate: Crate = { id: uid('crt'), name: newName.trim(), color: '#22c55e', trackIds: [], createdAt: now(), updatedAt: now() };
    setCrates(previous => [...previous, crate]);
    setActiveId(crate.id);
    setNewName('');
    setAddTracksOpen(false);
  };
  const remove = (crate: Crate) => {
    if (!window.confirm(`Delete crate “${crate.name}”? Tracks will stay in your library.`)) return;
    setCrates(previous => previous.filter(item => item.id !== crate.id));
    onUndo({ message: `${crate.name} deleted`, action: () => { setCrates(previous => [...previous, crate]); onUndo(null); } });
    window.setTimeout(() => onUndo(null), 6000);
  };
  const addTrack = (id: string) => {
    if (!active) return;
    setCrates(previous => previous.map(crate => crate.id === active.id && !crate.trackIds.includes(id)
      ? { ...crate, trackIds: [...crate.trackIds, id], updatedAt: now() }
      : crate));
  };
  const removeTrack = (id: string) => {
    if (!active) return;
    setCrates(previous => previous.map(crate => crate.id === active.id
      ? { ...crate, trackIds: crate.trackIds.filter(trackId => trackId !== id), updatedAt: now() }
      : crate));
  };
  if (!crates.length) return <div className="reveal"><EmptyCrates newName={newName} setNewName={setNewName} create={create} /></div>;
  return (
    <div className="reveal space-y-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><div className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.2em] text-primary">Preparation · {crates.length} crates</div><h1 className="font-display text-4xl font-semibold tracking-[-.055em]">Crates</h1></div>
        <div className="flex gap-2"><input value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => event.key === 'Enter' && create()} data-testid="input-new-crate" placeholder="New crate name" className="h-9 w-40 rounded-md border border-border bg-card px-3 text-[11px] outline-none focus:border-primary" /><button onClick={create} data-testid="button-create-crate" className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-[12px] font-bold text-primary-foreground"><Plus size={14} /> Create</button></div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="panel-line h-fit rounded-xl p-2">
          {crates.map(crate => {
            const count = tracks.filter(track => crate.trackIds.includes(track.id)).length;
            return <button key={crate.id} onClick={() => { setActiveId(crate.id); setAddTracksOpen(false); setTrackSearch(''); }} data-testid={`button-crate-${crate.id}`} aria-current={crate.id === active?.id ? 'true' : undefined} className={`mb-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-left last:mb-0 ${crate.id === active?.id ? 'bg-secondary' : 'hover:bg-secondary/70'}`}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: crate.color }} /><span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{crate.name}</span><span className="font-mono-ui text-[10px] text-muted-foreground">{count}</span></button>;
          })}
        </aside>
        {active && <section className="panel-line overflow-hidden rounded-xl">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div><div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: active.color }} /><h2 className="font-display text-xl font-semibold">{active.name}</h2></div><p className="mt-1 text-[11px] text-muted-foreground">{members.length} selected track{members.length === 1 ? '' : 's'} · ready for prep</p></div>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => { setAddTracksOpen(value => !value); setTrackSearch(''); }} aria-expanded={addTracksOpen} data-testid="button-add-tracks-to-crate" className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-2 text-[11px] font-bold text-primary-foreground"><Plus size={13} /> {addTracksOpen ? 'Done' : 'Add tracks'}</button>
              <button onClick={() => setEditing(active)} data-testid="button-edit-crate" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-[11px] hover:border-primary/50"><Pencil size={13} /> Edit</button>
              <button onClick={() => remove(active)} data-testid="button-delete-crate" aria-label={`Delete ${active.name}`} className="rounded-md border border-border p-2 text-muted-foreground hover:border-destructive/50 hover:text-destructive"><Trash2 size={14} /></button>
            </div>
          </div>
          {addTracksOpen && <div className="border-b border-border bg-card/40 p-4 sm:p-5">
            <label className="relative block">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={trackSearch} onChange={event => setTrackSearch(event.target.value)} autoFocus data-testid="input-search-crate-tracks" placeholder="Find library tracks to add" className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-[11px] outline-none focus:border-primary" />
            </label>
            <div className="mt-3 max-h-72 divide-y divide-border/70 overflow-y-auto rounded-md border border-border">
              {availableTracks.length ? availableTracks.map(track => <div key={track.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-secondary text-primary"><Music2 size={13} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold">{track.title}</span><span className="block truncate text-[10px] text-muted-foreground">{track.artist}</span></span>
                <span className="hidden font-mono-ui text-[10px] text-muted-foreground sm:block">{track.bpm ?? '—'} BPM</span>
                <button onClick={() => addTrack(track.id)} data-testid={`button-add-crate-track-${track.id}`} className="rounded-md border border-border px-2.5 py-1.5 text-[10px] font-bold hover:border-primary/50">Add</button>
              </div>) : <p className="px-4 py-5 text-center text-[10px] text-muted-foreground">{trackSearch ? 'No unadded tracks match that search.' : 'Every library track is already in this crate.'}</p>}
            </div>
          </div>}
          {members.length ? <div className="divide-y divide-border/70">{members.map(track => <div key={track.id} data-testid={`row-crate-member-${track.id}`} className="data-row flex items-center gap-3 px-5 py-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded bg-secondary text-primary"><Music2 size={13} /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold">{track.title}</span><span className="block truncate text-[10px] text-muted-foreground">{track.artist}</span></span>
            <span className="hidden font-mono-ui text-[10px] text-muted-foreground sm:block">{track.bpm ?? '—'} BPM</span>
            <button type="button" onClick={() => onSelectTrack(track.id)} data-testid={`button-open-crate-track-${track.id}`} className="text-[10px] text-primary hover:underline">Inspect</button>
            <button type="button" onClick={() => removeTrack(track.id)} aria-label={`Remove ${track.title} from ${active.name}`} data-testid={`button-remove-crate-track-${track.id}`} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><X size={13} /></button>
          </div>)}</div> : !addTracksOpen && <div className="flex flex-col items-center px-5 py-12 text-center">
            <ListMusic size={20} className="mb-2 text-muted-foreground" />
            <p className="text-[11px] font-semibold">This crate is empty</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Add selected songs from your library to build this crate.</p>
            <button onClick={() => setAddTracksOpen(true)} className="mt-3 rounded-md border border-border px-3 py-2 text-[10px] font-bold hover:border-primary/50"><Plus size={12} className="mr-1 inline" /> Add tracks</button>
          </div>}
        </section>}
      </div>
      {editing && <CrateEditDialog crate={editing} onClose={() => setEditing(null)} onSave={patch => { setCrates(previous => previous.map(crate => crate.id === editing.id ? { ...crate, ...patch, updatedAt: now() } : crate)); setEditing(null); }} />}
    </div>
  );
}
function EmptyCrates({ newName, setNewName, create }: { newName: string; setNewName: (v: string) => void; create: () => void }) { return <div className="panel-line flex min-h-[60vh] items-center justify-center rounded-xl text-center"><div><div className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-xl bg-secondary text-primary"><ListMusic size={22} /></div><h2 className="font-display text-2xl font-semibold">No crates yet</h2><p className="mt-2 text-xs text-muted-foreground">Make a focused set for the next room, radio hour, or long drive.</p><div className="mt-6 flex justify-center gap-2"><input value={newName} onChange={e => setNewName(e.target.value)} data-testid="input-first-crate" placeholder="Crate name" className="h-9 rounded-md border border-border bg-background px-3 text-xs outline-none" /><button onClick={create} data-testid="button-create-first-crate" className="rounded-md bg-primary px-3 text-xs font-bold text-primary-foreground">Create crate</button></div></div></div>; }

function Health({ tracks, browserAudioFiles, importedAudioTrackIds, missingNativePaths, desktopRuntime, onUpdate, onEdit, onNavigate }: {
  tracks: Track[];
  browserAudioFiles: ReadonlyMap<string, Blob>;
  importedAudioTrackIds: ReadonlySet<string>;
  missingNativePaths: ReadonlySet<string>;
  desktopRuntime: boolean;
  onUpdate: (id: string, patch: Partial<Track>) => void;
  onEdit: (track: Track) => void;
  onNavigate: (tab: Tab) => void;
}) {
  const missing = tracks.filter(track => track.bpm === null || track.key === null).length;
  const tagged = tracks.length - missing;
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [batch, setBatch] = useState<{ completed: number; total: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestSequenceRef = useRef(0);
  const batchSequenceRef = useRef(0);
  const cancelPendingRef = useRef<(() => void) | null>(null);

  const canAnalyze = (track: Track) => track.source === 'audio' && (
    browserAudioFiles.has(track.id)
    || (desktopRuntime && importedAudioTrackIds.has(track.id))
    || (desktopRuntime && Boolean(track.filePath) && !missingNativePaths.has(track.filePath!))
  );
  const analyzableTracks = tracks.filter(canAnalyze);

  useEffect(() => () => {
    requestSequenceRef.current++;
    batchSequenceRef.current++;
    cancelPendingRef.current?.();
    workerRef.current?.terminate();
  }, []);

  const cancelAnalysis = () => {
    requestSequenceRef.current++;
    batchSequenceRef.current++;
    cancelPendingRef.current?.();
    workerRef.current?.terminate();
    workerRef.current = null;
    setBatch(null);
    setActiveTrackId(null);
    setProgress(0);
    setStatus('Analysis cancelled. No result was saved.');
  };

  const analyzeTrack = async (track: Track): Promise<boolean> => {
    const requestId = ++requestSequenceRef.current;
    setActiveTrackId(track.id);
    setProgress(0);
    setStatus(`Opening ${track.title}…`);
    setError('');
    try {
      let audioBlob = browserAudioFiles.get(track.id);
      if (!audioBlob && desktopRuntime && track.filePath) {
        const authorizedPath = await invoke<string>('authorize_track_file', { path: track.filePath });
        const response = await fetch(convertFileSrc(authorizedPath));
        if (!response.ok) throw new Error('Could not read this audio file.');
        audioBlob = await response.blob();
      }
      if (!audioBlob && desktopRuntime && importedAudioTrackIds.has(track.id)) {
        audioBlob = (await loadDesktopImportedAudioTrack(track.id, invoke)) ?? undefined;
      }
      if (requestSequenceRef.current !== requestId) return false;
      if (!audioBlob) throw new Error('This audio is not available in the current session. Re-add the file to analyze it.');
      if (audioBlob.size > 150 * 1024 * 1024) throw new Error('This file is over 150 MB. Analysis is limited to smaller files to protect memory.');
      if ((track.durationSeconds ?? 0) > 30 * 60) throw new Error('Analysis is limited to tracks under 30 minutes.');

      setStatus('Decoding audio…');
      setProgress(5);
      const context = new AudioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await context.decodeAudioData(await audioBlob.arrayBuffer());
      } finally {
        await context.close();
      }
      if (requestSequenceRef.current !== requestId) return false;

      const result = await new Promise<{
        bpm: number | null;
        bpmConfidence?: number | null;
        key: string | null;
        camelot: string | null;
        keyConfidence?: number | null;
        energy: number | null;
        durationSeconds: number;
        beatGridSeconds: number[];
        waveform: number[];
      } | null>((resolve, reject) => {
        const worker = new Worker(new URL('./workers/track-analysis.worker.ts', import.meta.url), { type: 'module' });
        workerRef.current = worker;
        let cancel = () => {};
        const finish = (value: {
          bpm: number | null;
          bpmConfidence?: number | null;
          key: string | null;
          camelot: string | null;
          keyConfidence?: number | null;
          energy: number | null;
          durationSeconds: number;
          beatGridSeconds: number[];
          waveform: number[];
        } | null) => {
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          if (cancelPendingRef.current === cancel) cancelPendingRef.current = null;
          resolve(value);
        };
        cancel = () => finish(null);
        cancelPendingRef.current = cancel;
        worker.onmessage = (event: MessageEvent<{
          type: 'progress' | 'done';
          progress?: number;
          result?: {
            bpm: number | null;
            bpmConfidence?: number | null;
            key: string | null;
            camelot: string | null;
            keyConfidence?: number | null;
            energy: number | null;
            durationSeconds: number;
            beatGridSeconds: number[];
            waveform: number[];
          };
        }>) => {
          if (requestSequenceRef.current !== requestId) return;
          if (event.data.type === 'progress') {
            setProgress(Math.max(5, Math.min(99, 5 + (event.data.progress ?? 0) * 95)));
            setStatus(`Analyzing ${track.title}…`);
            return;
          }
          if (!event.data.result) {
            reject(new Error('The analyzer returned no result.'));
            return;
          }
          finish(event.data.result);
        };
        worker.onerror = event => reject(new Error(event.message || 'Audio analysis failed.'));
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice());
        worker.postMessage(
          { type: 'analyze', sampleRate: decoded.sampleRate, channels: channels.map(channel => channel.buffer) },
          channels.map(channel => channel.buffer),
        );
      });
      if (!result || requestSequenceRef.current !== requestId) return false;
      const analysis: TrackAnalysis = {
        ...result,
        analyzedAt: new Date().toISOString(),
        version: 'local-v2',
      };
      onUpdate(track.id, { analysis, analyzed: true });
      setProgress(100);
      setStatus(`Finished ${track.title}. Review estimates before applying them.`);
      return true;
    } catch (reason) {
      if (requestSequenceRef.current !== requestId) return false;
      const message = reason instanceof Error ? reason.message : 'Could not analyze this audio file.';
      setError(`${track.title}: ${message}`);
      return false;
    } finally {
      if (requestSequenceRef.current === requestId) {
        workerRef.current?.terminate();
        workerRef.current = null;
        cancelPendingRef.current = null;
        setActiveTrackId(null);
      }
    }
  };

  const analyzeAllAvailable = async () => {
    if (!analyzableTracks.length || batch) return;
    const batchId = ++batchSequenceRef.current;
    const queue = [...analyzableTracks];
    let completed = 0;
    const failedTitles: string[] = [];
    setBatch({ completed, total: queue.length });
    setError('');
    setStatus('Starting library analysis…');
    for (const track of queue) {
      if (batchSequenceRef.current !== batchId) return;
      const succeeded = await analyzeTrack(track);
      if (!succeeded && batchSequenceRef.current !== batchId) return;
      if (!succeeded) failedTitles.push(track.title);
      completed++;
      setBatch({ completed, total: queue.length });
    }
    if (batchSequenceRef.current !== batchId) return;
    setBatch(null);
    if (failedTitles.length) {
      const failedPreview = failedTitles.slice(0, 5).join(', ');
      setError(`Could not analyze ${failedTitles.length} track${failedTitles.length === 1 ? '' : 's'}: ${failedPreview}${failedTitles.length > 5 ? ', and more' : ''}. Check the audio files and retry.`);
    }
    setStatus(failedTitles.length
      ? `Finished ${completed - failedTitles.length} of ${queue.length} tracks.`
      : `Analysis complete for all ${queue.length} available tracks. Review estimates before applying them.`);
  };

  const batchPercent = batch ? Math.round(((batch.completed + progress / 100) / batch.total) * 100) : 0;

  return (
    <div className="reveal space-y-6">
      <div>
       <div className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.2em] text-primary">Diagnostics</div>
        <h1 className="font-display text-4xl font-semibold tracking-[-.055em]">Library health</h1>
        <p className="mt-3 max-w-2xl text-[13px] leading-6 text-muted-foreground">Analyze local audio for BPM, musical key, Camelot notation, and energy. Camelot is mapped from the detected key. Estimates stay separate until you apply them.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Tracks with BPM and key" value={tracks.length ? `${tagged}/${tracks.length}` : '0'} detail={missing ? `${missing} missing one or both values` : 'metadata present'} accent="teal" />
        <Metric label="Audio ready to analyze" value={String(analyzableTracks.length)} detail={`${tracks.length - analyzableTracks.length} records have no accessible audio`} accent="teal" />
         <Metric label="Library storage" value="Ready" detail={desktopRuntime ? 'Desktop database' : 'Browser database'} accent="blue" />
      </div>
      <section className="panel-line rounded-xl">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="font-display text-lg font-semibold">BPM, key, Camelot, and energy</h2><p className="mt-1 text-[11px] text-muted-foreground">Analysis runs locally, one track at a time to limit memory. Camelot is derived from the key estimate; confidence is shared with that estimate. Values stay separate until applied.</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-md bg-accent/10 px-2.5 py-1.5 font-mono-ui text-[10px] text-accent"><CircleHelp size={13} /> Offline analysis</div>
            {batch ? (
              <button onClick={cancelAnalysis} data-testid="button-cancel-analysis-batch" className="rounded-md border border-border px-3 py-2 text-[10px] font-bold hover:border-destructive/50 hover:text-destructive">Cancel batch</button>
            ) : (
              <button onClick={() => void analyzeAllAvailable()} disabled={!analyzableTracks.length || activeTrackId !== null} data-testid="button-analyze-all-tracks" className="rounded-md bg-primary px-3 py-2 text-[10px] font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">Analyze all available ({analyzableTracks.length})</button>
            )}
          </div>
        </div>
        {batch && <div className="border-b border-border px-5 py-3">
          <div className="flex items-center justify-between gap-3 text-[10px]"><span role="status" className="min-w-0 truncate text-muted-foreground">{status || `Analyzing track ${batch.completed + 1} of ${batch.total}…`}</span><span className="shrink-0 font-mono-ui text-primary">{batch.completed}/{batch.total} · {batchPercent}%</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-[width]" style={{ width: `${batchPercent}%` }} /></div>
        </div>}
        {tracks.length === 0 ? (
          <div className="p-12 text-center text-xs text-muted-foreground">Your library is empty. <button onClick={() => onNavigate('overview')} className="text-primary hover:underline">Add tracks from overview.</button></div>
        ) : (
          <div className="divide-y divide-border/70">
            {tracks.map(track => {
              const hasMetadata = track.bpm !== null && track.key !== null;
              const trackCanAnalyze = canAnalyze(track);
              const analysis = track.analysis;
              const isActive = activeTrackId === track.id;
              return (
                <div key={track.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${hasMetadata ? 'bg-primary/10 text-primary' : 'bg-accent/10 text-accent'}`}>{hasMetadata ? <Check size={14} /> : <AlertTriangle size={14} />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-semibold">{track.title} <span className="font-normal text-muted-foreground">· {track.artist}</span></div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                       {analysis ? `Analyzed · ${new Date(analysis.analyzedAt).toLocaleDateString()}` : hasMetadata ? 'Imported or manually entered metadata' : 'No BPM or key values yet'}
                    </div>
                    {analysis && <div className="mt-1 font-mono-ui text-[9px] text-primary">Estimate: {analysis.bpm ?? '—'} BPM · {analysis.key ?? '—'} · Camelot {analysis.camelot ?? camelotForKey(analysis.key) ?? '—'} · energy {analysis.energy ?? '—'}/10{analysis.bpmConfidence != null ? ` · tempo match ${Math.round(analysis.bpmConfidence * 100)}%` : ''}{analysis.keyConfidence != null ? ` · key separation ${Math.round(analysis.keyConfidence * 100)}%` : ''}</div>}
                    {track.lockedFields?.length ? <div className="mt-1 text-[9px] text-muted-foreground">Manual values protected: {track.lockedFields.map(field => field === 'durationSeconds' ? 'duration' : field).join(', ')}</div> : null}
                    {isActive && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
                        <span className="font-mono-ui text-[9px] text-muted-foreground">{Math.round(progress)}%</span>
                        <button onClick={cancelAnalysis} className="text-[9px] font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 font-mono-ui text-[10px] text-muted-foreground">{track.bpm ?? '—'} BPM · {formatKeyWithCamelot(track.key) ?? '—'}</span>
                  <button
                    onClick={() => onEdit(track)}
                    data-testid={`button-edit-bpm-key-${track.id}`}
                    aria-label={`Edit BPM and key for ${track.title}`}
                    className="shrink-0 rounded-md border border-border px-2.5 py-2 text-[9px] font-bold hover:border-primary/50"
                  >
                    Edit BPM/key
                  </button>
                  {isActive ? (
                    <span className="text-[9px] text-primary">{status}</span>
                  ) : (
                    <button onClick={() => void analyzeTrack(track)} disabled={!trackCanAnalyze || activeTrackId !== null || batch !== null} title={trackCanAnalyze ? 'Analyze track' : 'Add or scan an audio file first'} className="shrink-0 rounded-md border border-border px-2.5 py-2 text-[9px] font-bold hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40">
                       {analysis ? 'Analyze again' : 'Analyze track'}
                    </button>
                  )}
                  {analysis && (
                    <button
                      onClick={() => onUpdate(track.id, analysisApplyPatch(track))}
                      className="shrink-0 rounded-md bg-primary px-2.5 py-2 text-[9px] font-bold text-primary-foreground"
                    >
                      {track.lockedFields?.length ? 'Apply unlocked estimates' : 'Apply estimate'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {status && !activeTrackId && <p role="status" className="border-t border-border px-5 py-2 text-[10px] text-muted-foreground">{status}</p>}
        {error && <p role="alert" className="border-t border-destructive/20 px-5 py-3 text-[10px] text-destructive">{error}</p>}
      </section>
    </div>
  );
}

function ImportDialog({ onClose, onFiles, onDemo, onChooseFolder, onRescanFolder, nativeFolder }: {
  onClose: () => void;
  onFiles: (files: FileList | null) => void;
  onDemo: () => void;
  onChooseFolder?: () => void;
  onRescanFolder?: () => void;
  nativeFolder: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <Modal title="Bring music into Drop Theory Pro" onClose={onClose}><div className="space-y-5">
    {onChooseFolder && <button onClick={onChooseFolder} data-testid="button-choose-native-folder" className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2.5 text-[12px] font-bold text-primary-foreground"><FolderOpen size={14} /> Choose a music folder</button>}
    {nativeFolder && <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-[10px]"><span className="min-w-0 truncate text-muted-foreground" title={nativeFolder}>Saved folder: {nativeFolder}</span>{onRescanFolder && <button onClick={onRescanFolder} data-testid="button-rescan-native-folder" className="shrink-0 font-bold text-primary hover:underline">Rescan</button>}</div>}
    <div onClick={() => inputRef.current?.click()} className="cursor-pointer rounded-xl border border-dashed border-primary/50 bg-primary/5 p-8 text-center hover:bg-primary/10"><input ref={inputRef} type="file" multiple accept="audio/*,.csv,.m3u,.m3u8,.xml" onChange={e => onFiles(e.target.files)} data-testid="input-import-files" className="hidden" /><div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg bg-primary/15 text-primary"><FolderOpen size={20} /></div><div className="text-sm font-semibold">Choose audio, CSV, M3U, or rekordbox XML files</div><div className="mt-1 text-[11px] text-muted-foreground">Files are inspected before import. XML import reads an exported XML file only; it never opens or modifies the live rekordbox database.</div></div>
    <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground"><span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" /></div>
    <button onClick={onDemo} data-testid="button-load-demo-dialog" className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 text-[12px] font-bold hover:border-primary/50"><Database size={14} className="text-primary" /> Load sample library</button>
    <p className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-primary" /> Audio files stay in their folders. Drop Theory Pro stores library metadata and file references in the workspace.</p>
  </div></Modal>;
}
function EditDialog({ track, onClose, onSave }: { track: Track; onClose: () => void; onSave: (patch: Partial<Track>) => void }) {
  const [form, setForm] = useState({ title: track.title, artist: track.artist, album: track.album, genre: track.genre, year: track.year?.toString() ?? '', durationSeconds: track.durationSeconds?.toString() ?? '', bpm: track.bpm?.toString() ?? '', key: track.key ?? '', energy: track.energy?.toString() ?? '', rating: track.rating.toString() });
  const [lockedFields, setLockedFields] = useState<LockedMetadataField[]>(track.lockedFields ?? []);
  const [validationError, setValidationError] = useState('');
  const update = (key: keyof typeof form, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const save = () => {
    const bpmText = form.bpm.trim();
    const bpm = bpmText ? Number(bpmText) : null;
    if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) {
      setValidationError('Enter a BPM from 20 to 300, or leave it blank.');
      return;
    }
    setValidationError('');
    onSave({
      ...form,
      year: form.year.trim() === '' ? null : Number(form.year) || null,
      durationSeconds: form.durationSeconds.trim() === '' ? null : Number(form.durationSeconds) || null,
      bpm,
      key: form.key.trim() || null,
      energy: form.energy.trim() === '' ? null : Number(form.energy) || 0,
      rating: Number(form.rating) || 0,
      lockedFields,
    });
  };
  return (
    <Modal title="Edit track metadata" onClose={onClose}>
      <div className="grid gap-4 sm:grid-cols-2">
        {(['title', 'artist', 'album', 'genre', 'year', 'durationSeconds', 'bpm', 'key', 'energy', 'rating'] as const).map(key => (
          <div key={key} className="space-y-1.5">
            <label className="block space-y-1.5">
              <span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">{key === 'durationSeconds' ? 'Duration (seconds)' : key === 'key' ? 'Key / Camelot' : key}</span>
              <input
                type={key === 'bpm' ? 'number' : 'text'}
                min={key === 'bpm' ? 20 : undefined}
                max={key === 'bpm' ? 300 : undefined}
                step={key === 'bpm' ? 0.1 : undefined}
                maxLength={key === 'key' ? 32 : undefined}
                value={form[key]}
                onChange={event => update(key, event.target.value)}
                data-testid={`input-edit-${key}`}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-[11px] outline-none focus:border-primary"
              />
            </label>
            {key === 'key' && <p className="font-mono-ui text-[9px] text-muted-foreground">Camelot notation: {camelotForKey(form.key) ?? '—'} (derived from the musical key)</p>}
            {isLockableMetadataField(key) && <label className="flex cursor-pointer items-center gap-2 text-[9px] text-muted-foreground"><input type="checkbox" checked={lockedFields.includes(key)} onChange={event => setLockedFields(previous => event.target.checked ? [...new Set([...previous, key])] : previous.filter(field => field !== key))} data-testid={`checkbox-lock-${key}`} /><span>Protect my manual {key === 'durationSeconds' ? 'duration' : key.toUpperCase()} value from estimates</span></label>}
          </div>
        ))}
      </div>
      {validationError && <p role="alert" className="mt-3 text-[10px] text-destructive">{validationError}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} data-testid="button-cancel-edit" className="rounded-md border border-border px-3 py-2 text-[11px]">Cancel</button>
        <button onClick={save} data-testid="button-save-edit" className="rounded-md bg-primary px-3 py-2 text-[11px] font-bold text-primary-foreground">Save changes</button>
      </div>
    </Modal>
  );
}
function CrateEditDialog({ crate, onClose, onSave }: { crate: Crate; onClose: () => void; onSave: (patch: Partial<Crate>) => void }) { const [name, setName] = useState(crate.name); const [color, setColor] = useState(crate.color); return <Modal title="Edit crate" onClose={onClose}><label className="block space-y-1.5"><span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Name</span><input value={name} onChange={e => setName(e.target.value)} data-testid="input-edit-crate-name" className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs outline-none focus:border-primary" /></label><label className="mt-4 block space-y-1.5"><span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Color</span><input type="color" value={color} onChange={e => setColor(e.target.value)} data-testid="input-edit-crate-color" className="h-9 w-full rounded-md border border-border bg-background px-2" /></label><div className="mt-6 flex justify-end gap-2"><button onClick={onClose} data-testid="button-cancel-crate-edit" className="rounded-md border border-border px-3 py-2 text-[11px]">Cancel</button><button onClick={() => onSave({ name: name.trim() || crate.name, color })} data-testid="button-save-crate-edit" className="rounded-md bg-primary px-3 py-2 text-[11px] font-bold text-primary-foreground">Save changes</button></div></Modal>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) { return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-5"><div className="w-full max-w-lg rounded-t-2xl border border-border bg-card p-5 shadow-2xl sm:rounded-xl sm:p-6"><div className="mb-6 flex items-center justify-between"><h2 className="font-display text-xl font-semibold">{title}</h2><button onClick={onClose} aria-label="Close dialog" data-testid="button-close-dialog" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"><X size={17} /></button></div>{children}</div></div>; }
