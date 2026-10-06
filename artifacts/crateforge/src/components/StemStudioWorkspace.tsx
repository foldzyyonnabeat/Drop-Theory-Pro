import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openNativeDialog } from '@tauri-apps/plugin-dialog';
import type { Track } from '@/lib/local-library';
import type { StemId } from '@/lib/audio-mixer';
import {
  type StemModelCompatibility,
  type StemModelSettings,
} from '@/components/StemModelSetup';
import { StemStudioView } from '@/components/StemStudioView';
import { loadDesktopImportedAudioTrack } from '@/lib/desktop-imported-audio';

type StemPaths = Record<StemId, string>;

interface StemSeparationEvent {
  jobId: string;
  status: 'running' | 'complete' | 'cancelled' | 'error';
  percent: number;
  message: string;
  stems?: StemPaths | null;
  error?: string | null;
}

interface StemStudioWorkspaceProps {
  tracks: Track[];
  importedAudioTrackIds: ReadonlySet<string>;
  missingNativePaths: ReadonlySet<string>;
  desktopRuntime: boolean;
  onImport: () => void;
}

const STEM_IDS: StemId[] = ['vocals', 'instrumental'];

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback;
}

export function StemStudioWorkspace({
  tracks,
  importedAudioTrackIds,
  missingNativePaths,
  desktopRuntime,
  onImport,
}: StemStudioWorkspaceProps) {
  const trackOptions = useMemo(
    () => tracks.filter(track => track.source === 'audio' || Boolean(track.filePath)),
    [tracks],
  );
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const selectedTrack = trackOptions.find(track => track.id === selectedTrackId) ?? null;
  const [stemSettings, setStemSettings] = useState<StemModelSettings>({
    modelChoice: 'uvr-mdx-inst-hq-5',
    overlap: 0.25,
  });
  const [stemCompatibility, setStemCompatibility] = useState<StemModelCompatibility | null>(null);
  const [separationBusy, setSeparationBusy] = useState(false);
  const [separationProgress, setSeparationProgress] = useState({ percent: 0, message: '' });
  const [stemPaths, setStemPaths] = useState<StemPaths | null>(null);
  const [selectedStems, setSelectedStems] = useState<StemId[]>(STEM_IDS);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [error, setError] = useState('');
  const activeJobRef = useRef('');
  const cancelRequestedRef = useRef(false);
  const nativeJobStartedRef = useRef(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (selectedTrackId && trackOptions.some(track => track.id === selectedTrackId)) return;
    const nextTrack = trackOptions[0] ?? null;
    setSelectedTrackId(nextTrack?.id ?? '');
    setStemPaths(null);
    setSelectedStems(STEM_IDS);
    setExportStatus('');
  }, [selectedTrackId, trackOptions]);

  useEffect(() => {
    setStemPaths(null);
    setSelectedStems(STEM_IDS);
    setExportStatus('');
    setError('');
  }, [selectedTrackId]);

  useEffect(() => () => {
    const jobId = activeJobRef.current;
    cancelRequestedRef.current = true;
    if (jobId && desktopRuntime && nativeJobStartedRef.current) {
      void invoke('cancel_stem_separation', { jobId }).catch(() => {});
    }
    activeJobRef.current = '';
    nativeJobStartedRef.current = false;
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, [desktopRuntime]);

  const onTrackChange = (id: string) => {
    const jobId = activeJobRef.current;
    cancelRequestedRef.current = true;
    if (jobId && desktopRuntime && nativeJobStartedRef.current) {
      void invoke('cancel_stem_separation', { jobId }).catch(() => {});
    }
    activeJobRef.current = '';
    nativeJobStartedRef.current = false;
    unlistenRef.current?.();
    unlistenRef.current = null;
    setSeparationBusy(false);
    setSeparationProgress({ percent: 0, message: '' });
    setSelectedTrackId(id);
  };

  const startSeparation = async () => {
    if (!desktopRuntime || !selectedTrack || !stemCompatibility?.compatible || separationBusy) return;
    const importedAudioAvailable = importedAudioTrackIds.has(selectedTrack.id);
    const nativePathAvailable = Boolean(
      selectedTrack.filePath && !missingNativePaths.has(selectedTrack.filePath),
    );
    if (!nativePathAvailable && !importedAudioAvailable) return;
    const jobId = crypto.randomUUID();
    activeJobRef.current = jobId;
    cancelRequestedRef.current = false;
    nativeJobStartedRef.current = false;
    setSeparationBusy(true);
    setSeparationProgress({ percent: 0, message: 'Starting model…' });
    setStemPaths(null);
    setError('');
    setExportStatus('');

    let unlisten = () => {};
    try {
      unlisten = await listen<StemSeparationEvent>('stem-separation', event => {
        const progress = event.payload;
        if (progress.jobId !== activeJobRef.current) return;
        setSeparationProgress({ percent: progress.percent, message: progress.message });
        if (progress.status === 'complete' && progress.stems) {
          setStemPaths(progress.stems);
          setSelectedStems(STEM_IDS);
          setSeparationProgress({ percent: 100, message: 'Ready.' });
          setSeparationBusy(false);
           setExportStatus('Vocals and instrumental are ready to export.');
          activeJobRef.current = '';
          unlistenRef.current?.();
          unlistenRef.current = null;
        } else if (progress.status === 'cancelled') {
          setSeparationBusy(false);
          setSeparationProgress({ percent: 0, message: 'Separation cancelled.' });
          activeJobRef.current = '';
          nativeJobStartedRef.current = false;
          unlistenRef.current?.();
          unlistenRef.current = null;
        } else if (progress.status === 'error') {
          setError(progress.error || progress.message || 'Separation failed.');
          setSeparationBusy(false);
          activeJobRef.current = '';
          nativeJobStartedRef.current = false;
          unlistenRef.current?.();
          unlistenRef.current = null;
        }
      });
      unlistenRef.current = unlisten;
    } catch (reason) {
      activeJobRef.current = '';
      setSeparationBusy(false);
      setError(errorMessage(reason, 'Could not listen for separation updates.'));
      return;
    }

    try {
      if (nativePathAvailable) {
        await invoke('start_stem_separation', {
          jobId,
          trackPath: selectedTrack.filePath,
          modelChoice: stemSettings.modelChoice,
          overlap: stemSettings.overlap,
        });
      } else {
        const importedAudio = await loadDesktopImportedAudioTrack(selectedTrack.id, invoke);
        if (!importedAudio) throw new Error('The saved local audio file is missing. Re-import it to continue.');
        if (activeJobRef.current !== jobId || cancelRequestedRef.current) return;
        const audioBytes = Array.from(new Uint8Array(await importedAudio.arrayBuffer()));
        await invoke('start_stem_separation_from_audio', {
          jobId,
          fileName: selectedTrack.fileName ?? selectedTrack.title,
          audioBytes,
          modelChoice: stemSettings.modelChoice,
          overlap: stemSettings.overlap,
        });
      }
      nativeJobStartedRef.current = true;
      if (activeJobRef.current !== jobId || cancelRequestedRef.current) {
        void invoke('cancel_stem_separation', { jobId }).catch(() => {});
      }
    } catch (reason) {
      unlisten();
      if (unlistenRef.current === unlisten) unlistenRef.current = null;
      if (activeJobRef.current === jobId) {
        activeJobRef.current = '';
        nativeJobStartedRef.current = false;
        setSeparationBusy(false);
        setError(errorMessage(reason, 'Could not start stem separation.'));
      }
    }
  };

  const cancelSeparation = async () => {
    const jobId = activeJobRef.current;
    if (!jobId) return;
    cancelRequestedRef.current = true;
    if (!nativeJobStartedRef.current) {
      setSeparationProgress(previous => ({
        ...previous,
        message: 'Cancelling after local audio is prepared…',
      }));
      return;
    }
    try {
      await invoke('cancel_stem_separation', { jobId });
      setSeparationProgress(previous => ({ ...previous, message: 'Cancelling separation…' }));
    } catch (reason) {
      setError(errorMessage(reason, 'Could not cancel stem separation.'));
    }
  };

  const toggleStem = (stem: StemId) => {
    setSelectedStems(previous => previous.includes(stem)
      ? previous.filter(selected => selected !== stem)
      : [...previous, stem]);
  };

  const exportSelectedStems = async () => {
    if (!desktopRuntime || !stemPaths || !selectedTrack || selectedStems.length === 0 || exportBusy) return;
    setExportBusy(true);
    setError('');
    setExportStatus('Choose a destination folder…');
    try {
      const selection = await openNativeDialog({
        directory: true,
        multiple: false,
        title: 'Choose a folder for the selected stems',
      });
      const outputDirectory = typeof selection === 'string' ? selection : selection?.[0];
      if (!outputDirectory) {
        setExportStatus('Export cancelled.');
        return;
      }
      const destination = await invoke<string>('export_separated_stems', {
        stemPaths,
        selectedStems,
        outputDirectory,
        trackName: selectedTrack.artist
          ? `${selectedTrack.artist} - ${selectedTrack.title}`
          : selectedTrack.title || selectedTrack.fileName || 'Track',
      });
      setExportStatus(`Exported ${selectedStems.length} stem${selectedStems.length === 1 ? '' : 's'} to ${destination}`);
    } catch (reason) {
      setError(errorMessage(reason, 'Could not export the selected stems.'));
      setExportStatus('Stem export failed.');
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <StemStudioView
      tracks={trackOptions}
      importedAudioTrackIds={importedAudioTrackIds}
      desktopRuntime={desktopRuntime}
      missingNativePaths={missingNativePaths}
      selectedTrackId={selectedTrackId}
      selectedTrack={selectedTrack}
      onTrackChange={onTrackChange}
      onImport={onImport}
      stemCompatibility={stemCompatibility}
      onConfigurationChange={(settings, compatibility) => {
        setStemSettings(settings);
        setStemCompatibility(compatibility);
      }}
      separationBusy={separationBusy}
      separationProgress={separationProgress}
      stemPaths={stemPaths}
      selectedStems={selectedStems}
      onToggleStem={toggleStem}
      onSeparate={() => void startSeparation()}
      onCancel={() => void cancelSeparation()}
      canSeparate={Boolean(
        desktopRuntime
        && selectedTrack
        && (
          importedAudioTrackIds.has(selectedTrack.id)
          || (selectedTrack.filePath && !missingNativePaths.has(selectedTrack.filePath))
        )
        && stemCompatibility?.compatible
        && !separationBusy,
      )}
      exportBusy={exportBusy}
      onExportSelected={() => void exportSelectedStems()}
      exportStatus={exportStatus}
      error={error}
    />
  );
}