import { useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Disc3, Music2, Pause, Play, Repeat2, RotateCcw, Volume2 } from 'lucide-react';
import type { Track } from '@/lib/local-library';
import {
  LocalAudioMixer,
  NativeAudioMixer,
  type DeckId,
  type NativeAudioDevice,
  type NativeAudioStatus,
  type StemId,
} from '@/lib/audio-mixer';
import { getLoopDurationSeconds, LOOP_BEAT_COUNTS, type LoopBeatCount } from '@/lib/deck-loop';
import { MIDI_ACTION_EVENT, type MidiActionDetail } from '@/lib/midi-types';
import { MidiControllerPanel } from '@/components/MidiControllerPanel';
import { StemModelSetup, type StemModelCompatibility, type StemModelSettings } from '@/components/StemModelSetup';
import { STEM_IDS, StemMixerControls } from '@/components/StemMixerControls';
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

interface DecksWorkspaceProps {
  tracks: Track[];
  browserAudioFiles: ReadonlyMap<string, Blob>;
  importedAudioTrackIds: ReadonlySet<string>;
  missingNativePaths: ReadonlySet<string>;
  desktopRuntime: boolean;
  audioHydrated: boolean;
  onImport: () => void;
}

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

export function DecksWorkspace({ tracks, browserAudioFiles, importedAudioTrackIds, missingNativePaths, desktopRuntime, audioHydrated, onImport }: DecksWorkspaceProps) {
  const mixerRef = useRef<LocalAudioMixer | null>(null);
  if (!mixerRef.current) mixerRef.current = new LocalAudioMixer();
  const mixer = mixerRef.current;
  const nativeMixerRef = useRef<NativeAudioMixer | null>(null);
  if (!nativeMixerRef.current) nativeMixerRef.current = new NativeAudioMixer(invoke);
  const nativeMixer = nativeMixerRef.current;
  const [crossfader, setCrossfader] = useState(0.5);
  const [masterGain, setMasterGain] = useState(0.82);
  const [nativeOutputs, setNativeOutputs] = useState<NativeAudioDevice[]>([]);
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [nativeAudioStatus, setNativeAudioStatus] = useState<NativeAudioStatus | null>(null);
  const [nativeOutputError, setNativeOutputError] = useState('');
  const [stemSettings, setStemSettings] = useState<StemModelSettings>({
    modelChoice: 'uvr-mdx-inst-hq-5',
    overlap: 0.25,
  });
  const [stemCompatibility, setStemCompatibility] = useState<StemModelCompatibility | null>(null);
  const midiMixActionsRef = useRef({
    crossfader: (_value: number) => {},
    master: (_value: number) => {},
  });

  useEffect(() => () => { void mixer.dispose(); }, [mixer]);

  useEffect(() => {
    if (!desktopRuntime) return;
    let active = true;
    const refreshOutputs = () => {
      void nativeMixer.getOutputs().then(outputs => {
        if (!active) return;
        setNativeOutputs(outputs.devices);
        setSelectedOutputId(outputs.selectedDeviceId ?? '');
        setNativeOutputError(outputs.error ?? '');
      }).catch(reason => {
        if (active) setNativeOutputError(reason instanceof Error ? reason.message : 'Could not list audio output devices.');
      });
    };
    const refreshStatus = () => {
      void nativeMixer.getStatus().then(status => {
        if (!active) return;
        setNativeAudioStatus(status);
        if (status.outputError) setNativeOutputError(status.outputError);
      }).catch(reason => {
        if (active) setNativeOutputError(reason instanceof Error ? reason.message : 'Could not read native audio status.');
      });
    };
    refreshOutputs();
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 150);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [desktopRuntime, nativeMixer]);

  const playableCount = useMemo(
    () => tracks.filter(track => browserAudioFiles.has(track.id) || (desktopRuntime && (importedAudioTrackIds.has(track.id) || (Boolean(track.filePath) && !missingNativePaths.has(track.filePath!))))).length,
    [tracks, browserAudioFiles, importedAudioTrackIds, missingNativePaths, desktopRuntime],
  );
  const unavailableNativeCount = tracks.filter(
    track => Boolean(track.filePath && missingNativePaths.has(track.filePath) && !browserAudioFiles.has(track.id) && !importedAudioTrackIds.has(track.id)),
  ).length;
  const browserTracksNeedReimport = audioHydrated && tracks.some(
    track => track.source === 'audio' && !browserAudioFiles.has(track.id)
      && (!desktopRuntime || (!track.filePath && !importedAudioTrackIds.has(track.id))),
  );

  const updateCrossfader = (position: number) => {
    setCrossfader(position);
    mixer.setCrossfader(position);
    if (desktopRuntime) void nativeMixer.setCrossfader(position).catch(reason => {
      setNativeOutputError(reason instanceof Error ? reason.message : 'Could not update the native crossfader.');
    });
  };
  const updateMasterGain = (gain: number) => {
    setMasterGain(gain);
    mixer.setMasterGain(gain);
    if (desktopRuntime) void nativeMixer.setMasterGain(gain).catch(reason => {
      setNativeOutputError(reason instanceof Error ? reason.message : 'Could not update native master output.');
    });
  };
  const selectNativeOutput = async (deviceId: string) => {
    try {
      const outputs = await nativeMixer.selectOutput(deviceId);
      setNativeOutputs(outputs.devices);
      setSelectedOutputId(outputs.selectedDeviceId ?? deviceId);
      setNativeOutputError(outputs.error ?? '');
    } catch (reason) {
      setNativeOutputError(reason instanceof Error ? reason.message : 'Could not change the audio output device.');
    }
  };
  const updateStemConfiguration = (settings: StemModelSettings, compatibility: StemModelCompatibility | null) => {
    setStemSettings(settings);
    setStemCompatibility(compatibility);
  };
  midiMixActionsRef.current = { crossfader: updateCrossfader, master: updateMasterGain };

  useEffect(() => {
    const receiveMidi = (event: Event) => {
      const detail = (event as CustomEvent<MidiActionDetail>).detail;
      if (detail?.action === 'crossfader') midiMixActionsRef.current.crossfader(detail.value);
      if (detail?.action === 'master') midiMixActionsRef.current.master(detail.value);
    };
    window.addEventListener(MIDI_ACTION_EVENT, receiveMidi);
    return () => window.removeEventListener(MIDI_ACTION_EVENT, receiveMidi);
  }, []);

  return (
    <div className="reveal space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.2em] text-primary">Performance · {playableCount} playable tracks</div>
          <h1 className="font-display text-4xl font-semibold tracking-[-.055em]">Decks</h1>
          <p className="mt-2 max-w-2xl text-[12px] leading-5 text-muted-foreground">
            Two independent players, one crossfader. Your files remain under your control.
          </p>
        </div>
        <button onClick={onImport} data-testid="button-decks-import" className="flex w-fit items-center gap-2 rounded-md border border-border bg-card px-3.5 py-2.5 text-[12px] font-bold hover:border-primary/50">
          <Music2 size={14} /> Add audio
        </button>
      </div>

      {desktopRuntime ? (
        <section className="panel-line flex flex-col gap-3 rounded-xl px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex min-w-0 flex-1 items-center gap-3 text-[10px]">
            <span className="shrink-0 font-mono-ui uppercase tracking-[.14em] text-muted-foreground">Native output</span>
            <select
              aria-label="Native audio output device"
              value={selectedOutputId}
              onChange={event => void selectNativeOutput(event.target.value)}
              disabled={nativeOutputs.length === 0}
              className="h-9 min-w-0 max-w-xl flex-1 rounded-md border border-border bg-background px-2 outline-none focus:border-primary disabled:opacity-50"
            >
              {nativeOutputs.length === 0 && <option value="">No output devices found</option>}
              {nativeOutputs.map(device => (
                <option key={device.id} value={device.id}>
                  {device.name}{device.isDefault ? ' · system default' : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              void nativeMixer.getOutputs().then(outputs => {
                setNativeOutputs(outputs.devices);
                setSelectedOutputId(outputs.selectedDeviceId ?? '');
                setNativeOutputError(outputs.error ?? '');
              }).catch(reason => {
                setNativeOutputError(reason instanceof Error ? reason.message : 'Could not refresh audio output devices.');
              });
            }}
            className="rounded-md border border-border px-3 py-2 text-[10px] font-semibold hover:border-primary/50"
          >
            Refresh devices
          </button>
          <span role={nativeOutputError ? 'alert' : 'status'} className={`text-[10px] ${nativeOutputError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {nativeOutputError || (nativeAudioStatus?.outputName ? `Playing through ${nativeAudioStatus.outputName}` : 'Select an output device to start native playback.')}
          </span>
        </section>
      ) : (
        <p role="status" className="rounded-lg border border-border bg-card/60 px-4 py-3 text-[10px] leading-5 text-muted-foreground">
          The browser version uses Web Audio. Native Windows playback and output-device selection require the desktop app.
        </p>
      )}

      <StemModelSetup desktopRuntime={desktopRuntime} onConfigurationChange={updateStemConfiguration} />

      {playableCount === 0 && !audioHydrated && (
        <div role="status" className="panel-line rounded-xl px-6 py-10 text-center text-[12px] text-muted-foreground">Restoring saved audio…</div>
      )}

      {playableCount === 0 && audioHydrated && (
        <div className="panel-line flex flex-col items-center rounded-xl px-6 py-10 text-center">
          <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-primary/10 text-primary"><Disc3 size={22} /></div>
          <h2 className="font-display text-2xl font-semibold">Load your first track</h2>
          <p className="mt-2 max-w-md text-[12px] leading-5 text-muted-foreground">
            Import audio in the browser, or scan a music folder in the desktop app. Demo and playlist-only entries do not contain playable audio.
          </p>
          <button onClick={onImport} className="mt-5 rounded-md bg-primary px-4 py-2.5 text-[11px] font-bold text-primary-foreground">Choose audio</button>
        </div>
      )}

      {desktopRuntime && unavailableNativeCount > 0 && (
        <div role="status" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[11px] text-destructive">
          {unavailableNativeCount} saved audio source{unavailableNativeCount === 1 ? ' is' : 's are'} unavailable and hidden from the deck selectors. Library records are preserved; reconnect the drive and rescan its folder.
        </div>
      )}

      <div className={playableCount > 0 ? 'grid gap-4 xl:grid-cols-2' : 'hidden'}>
        <DeckPanel side="a" tracks={tracks} browserAudioFiles={browserAudioFiles} importedAudioTrackIds={importedAudioTrackIds} missingNativePaths={missingNativePaths} desktopRuntime={desktopRuntime} mixer={mixer} nativeMixer={nativeMixer} nativeStatus={nativeAudioStatus?.decks[0] ?? null} stemSettings={stemSettings} stemCompatibility={stemCompatibility} />
        <DeckPanel side="b" tracks={tracks} browserAudioFiles={browserAudioFiles} importedAudioTrackIds={importedAudioTrackIds} missingNativePaths={missingNativePaths} desktopRuntime={desktopRuntime} mixer={mixer} nativeMixer={nativeMixer} nativeStatus={nativeAudioStatus?.decks[1] ?? null} stemSettings={stemSettings} stemCompatibility={stemCompatibility} />
      </div>

      <MidiControllerPanel />

      {playableCount > 0 && (
        <>
          <section className="panel-line rounded-xl p-5 sm:p-6">
            <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)] md:items-end">
              <label className="block">
                <div className="mb-2 flex items-center justify-between font-mono-ui text-[10px] uppercase tracking-[.15em]">
                  <span className="text-primary">Deck A</span>
                  <span className="text-muted-foreground">Crossfader</span>
                  <span className="text-accent">Deck B</span>
                </div>
                <input
                  aria-label="Crossfader"
                  data-testid="input-crossfader"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={crossfader}
                  onChange={event => updateCrossfader(Number(event.target.value))}
                  className="h-2 w-full cursor-pointer accent-primary"
                />
              </label>
              <label className="block">
                <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Volume2 size={13} /> Master output</span>
                  <span className="font-mono-ui text-foreground">{Math.round(masterGain * 100)}%</span>
                </div>
                <input
                  aria-label="Master output"
                  data-testid="input-master-gain"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={masterGain}
                  onChange={event => updateMasterGain(Number(event.target.value))}
                  className="h-2 w-full cursor-pointer accent-primary"
                />
              </label>
            </div>
          </section>
        </>
      )}

      {browserTracksNeedReimport && (
        <p role="status" className="rounded-lg border border-border bg-card/60 px-4 py-3 text-[11px] leading-5 text-muted-foreground">
          Some library entries have metadata only; their audio is not available in this browser. Re-import those files to play them. Library metadata is preserved.
        </p>
      )}
    </div>
  );
}

function DeckPanel({ side, tracks, browserAudioFiles, importedAudioTrackIds, missingNativePaths, desktopRuntime, mixer, nativeMixer, nativeStatus, stemSettings, stemCompatibility }: {
  side: DeckId;
  tracks: Track[];
  browserAudioFiles: ReadonlyMap<string, Blob>;
  importedAudioTrackIds: ReadonlySet<string>;
  missingNativePaths: ReadonlySet<string>;
  desktopRuntime: boolean;
  mixer: LocalAudioMixer;
  nativeMixer: NativeAudioMixer;
  nativeStatus: NativeAudioStatus['decks'][number] | null;
  stemSettings: StemModelSettings;
  stemCompatibility: StemModelCompatibility | null;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const stemAudioRefs = useRef<Record<StemId, HTMLAudioElement | null>>({
    vocals: null, instrumental: null,
  });
  const [stemSources, setStemSources] = useState<StemPaths | null>(null);
  const [stemLocalPaths, setStemLocalPaths] = useState<StemPaths | null>(null);
  const stemSourcesRef = useRef<StemPaths | null>(null);
  const nativeRequestIdRef = useRef('');
  stemSourcesRef.current = stemSources;
  const [loadedStems, setLoadedStems] = useState<Record<StemId, boolean>>({
    vocals: false, instrumental: false,
  });
  const [stemsEnabled, setStemsEnabled] = useState(false);
  const [stemLevels, setStemLevels] = useState<Record<StemId, number>>({
    vocals: 1, instrumental: 1,
  });
  const [separationJobId, setSeparationJobId] = useState('');
  const [separationProgress, setSeparationProgress] = useState({ percent: 0, message: '' });
  const separationJobRef = useRef('');
  const unlistenSeparationRef = useRef<(() => void) | null>(null);
  const stemsEnabledRef = useRef(false);
  stemsEnabledRef.current = stemsEnabled;
  const [trackId, setTrackId] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [cuePosition, setCuePosition] = useState(0);
  const [gain, setGain] = useState(1);
  const [pitch, setPitch] = useState(0);
  const [equalizer, setEqualizer] = useState({ low: 0, mid: 0, high: 0 });
  const [loopBeats, setLoopBeats] = useState<LoopBeatCount>(4);
  const [loopRange, setLoopRange] = useState<{ start: number; end: number } | null>(null);
  const loopRangeRef = useRef(loopRange);
  loopRangeRef.current = loopRange;
  const track = tracks.find(item => item.id === trackId);
  const analysis = track?.analysis;
  const browserFile = track ? browserAudioFiles.get(track.id) : undefined;
  const managedAudioAvailable = Boolean(track && importedAudioTrackIds.has(track.id));
  const nativeDeck = desktopRuntime && Boolean(track?.filePath && !missingNativePaths.has(track.filePath));
  const playableTracks = useMemo(
    () => tracks.filter(item => browserAudioFiles.has(item.id) || (desktopRuntime && (importedAudioTrackIds.has(item.id) || (Boolean(item.filePath) && !missingNativePaths.has(item.filePath!))))),
    [tracks, browserAudioFiles, importedAudioTrackIds, missingNativePaths, desktopRuntime],
  );
  const sideName = side.toUpperCase();
  const sideColor = side === 'a' ? 'text-primary' : 'text-accent';
  const sideBorder = side === 'a' ? 'border-primary/25' : 'border-accent/25';
  const stemsReady = Boolean(stemSources) && STEM_IDS.every(stem => loadedStems[stem]);
  const effectiveReady = ready && (!stemsEnabled || stemsReady);

  const getStemElements = () => {
    const elements = {} as Record<StemId, HTMLAudioElement>;
    for (const stem of STEM_IDS) {
      const element = stemAudioRefs.current[stem];
      if (!element) return null;
      elements[stem] = element;
    }
    return elements;
  };
  const pauseAllAudio = () => {
    audioRef.current?.pause();
    for (const element of Object.values(stemAudioRefs.current)) element?.pause();
    if (nativeDeck) void nativeMixer.pause(side).catch(reason => {
      setError(reason instanceof Error ? reason.message : 'Could not pause native playback.');
    });
  };

  useEffect(() => {
    if (trackId && !playableTracks.some(item => item.id === trackId)) setTrackId('');
  }, [trackId, playableTracks]);

  useEffect(() => {
    if (!nativeDeck || !nativeStatus) return;
    setPlaying(nativeStatus.playing);
    setPosition(nativeStatus.position);
  }, [nativeDeck, nativeStatus?.playing, nativeStatus?.position]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    audio.pause();
    for (const element of Object.values(stemAudioRefs.current)) {
      element?.pause();
      if (element) {
        element.removeAttribute('src');
        element.load();
      }
    }
    if (separationJobRef.current && desktopRuntime) {
      void invoke('cancel_stem_separation', { jobId: separationJobRef.current }).catch(() => {});
    }
    separationJobRef.current = '';
    setSeparationJobId('');
    setSeparationProgress({ percent: 0, message: '' });
    setStemSources(null);
    setStemLocalPaths(null);
    stemSourcesRef.current = null;
    setLoadedStems({ vocals: false, instrumental: false });
    setStemsEnabled(false);
    stemsEnabledRef.current = false;
    mixer.setStemMode(side, false);
    audio.removeAttribute('src');
    audio.load();
    setReady(false);
    setLoading(false);
    setPlaying(false);
    setError('');
    setDuration(0);
    setPosition(0);
    setCuePosition(0);
    setPitch(0);
    setLoopBeats(4);
    setLoopRange(null);
    audio.playbackRate = 1;

    if (track?.filePath && desktopRuntime) {
      const requestId = crypto.randomUUID();
      nativeRequestIdRef.current = requestId;
      void nativeMixer.pause(side).catch(() => {});
      setLoading(true);
      nativeMixer.loadTrack(side, track.filePath, requestId)
        .then(status => {
          if (cancelled) return;
          setDuration(status.duration);
          setLoading(false);
          setReady(true);
          setError('');
        })
        .catch(reason => {
          if (cancelled) return;
          setLoading(false);
          setReady(false);
          if (reason instanceof Error && reason.message.includes('newer track load')) return;
          setError(reason instanceof Error ? reason.message : 'Could not load this track in the native audio engine.');
        });
    } else if (desktopRuntime) {
      void nativeMixer.unloadDeck(side).catch(() => {});
      if (track && browserFile) {
        objectUrl = URL.createObjectURL(browserFile);
        audio.src = objectUrl;
        audio.load();
        setLoading(true);
      } else if (track && managedAudioAvailable) {
        setLoading(true);
        void loadDesktopImportedAudioTrack(track.id, invoke)
          .then(importedAudio => {
            if (cancelled) return;
            if (!importedAudio) {
              setLoading(false);
              setError('The saved local audio file is missing. Re-import it to continue.');
              return;
            }
            objectUrl = URL.createObjectURL(importedAudio);
            audio.src = objectUrl;
            audio.load();
          })
          .catch(reason => {
            if (cancelled) return;
            setLoading(false);
            setError(reason instanceof Error ? reason.message : 'Could not read the saved local audio file.');
          });
      } else if (track) {
        setError('The saved local audio file is unavailable. Re-import it to continue.');
      }
    } else if (track && browserFile) {
      objectUrl = URL.createObjectURL(browserFile);
      audio.src = objectUrl;
      audio.load();
      setLoading(true);
    } else if (track) {
      setError('The browser no longer has access to this file. Re-add it to continue.');
    }

    return () => {
      cancelled = true;
      if (separationJobRef.current && desktopRuntime) {
        void invoke('cancel_stem_separation', { jobId: separationJobRef.current }).catch(() => {});
      }
      separationJobRef.current = '';
      unlistenSeparationRef.current?.();
      unlistenSeparationRef.current = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [track?.id, track?.filePath, browserFile, managedAudioAvailable, desktopRuntime, mixer, nativeMixer, side]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const stemElements = Object.values(stemAudioRefs.current).filter(
      (element): element is HTMLAudioElement => Boolean(element),
    );
    const allAudioElements = [audio, ...stemElements];
    const updateDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const updatePosition = () => {
      const activeElements = stemsEnabledRef.current ? stemElements : [audio];
      const driver = activeElements[0];
      if (!driver) return;
      const loop = loopRangeRef.current;
      if (loop && driver.currentTime >= loop.end) {
        for (const element of activeElements) element.currentTime = loop.start;
      }
      const positionNow = driver.currentTime;
      for (const element of activeElements.slice(1)) {
        if (Math.abs(element.currentTime - positionNow) > 0.08) element.currentTime = positionNow;
      }
      if (stemsEnabledRef.current) audio.currentTime = positionNow;
      setPosition(positionNow);
    };
    const onCanPlay = () => { setLoading(false); setReady(true); setError(''); };
    const stemNames = [...STEM_IDS];
    const stemEventHandlers = stemElements.map((element, index) => {
      const stem = stemNames[index];
      const onStemCanPlay = () => setLoadedStems(previous => ({ ...previous, [stem]: true }));
      const onStemError = () => setError('A separated stem could not be opened. Separate the track again to rebuild its cache.');
      element.addEventListener('canplay', onStemCanPlay);
      element.addEventListener('error', onStemError);
      return { element, onStemCanPlay, onStemError };
    });
    const onError = () => {
      setLoading(false);
      setReady(false);
      setError('This file could not be decoded by the current audio engine.');
    };
    const updatePlaying = () => {
      const activeElements = stemsEnabledRef.current ? stemElements : [audio];
      setPlaying(activeElements.some(element => !element.paused && !element.ended));
    };
    const onEnded = () => {
      const activeElements = stemsEnabledRef.current ? stemElements : [audio];
      for (const element of activeElements) {
        if (!element.ended) element.pause();
      }
      updatePlaying();
    };
    audio.addEventListener('loadedmetadata', updateDuration);
    for (const element of allAudioElements) element.addEventListener('timeupdate', updatePosition);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('error', onError);
    for (const element of allAudioElements) {
      element.addEventListener('play', updatePlaying);
      element.addEventListener('pause', updatePlaying);
      element.addEventListener('ended', onEnded);
    }
    return () => {
      audio.removeEventListener('loadedmetadata', updateDuration);
      for (const element of allAudioElements) element.removeEventListener('timeupdate', updatePosition);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('error', onError);
      for (const element of allAudioElements) {
        element.removeEventListener('play', updatePlaying);
        element.removeEventListener('pause', updatePlaying);
        element.removeEventListener('ended', onEnded);
      }
      for (const { element, onStemCanPlay, onStemError } of stemEventHandlers) {
        element.removeEventListener('canplay', onStemCanPlay);
        element.removeEventListener('error', onStemError);
      }
    };
  }, [stemSources]);

  useEffect(() => {
    if (nativeDeck || !stemSources) return;
    const elements = getStemElements();
    if (!elements) return;
    setStemsEnabled(false);
    stemsEnabledRef.current = false;
    mixer.setStemMode(side, false);
    setLoadedStems({ vocals: false, instrumental: false });
    for (const stem of STEM_IDS) {
      const element = elements[stem];
      element.pause();
      element.currentTime = audioRef.current?.currentTime ?? 0;
      element.playbackRate = audioRef.current?.playbackRate ?? 1;
    }
  }, [stemSources, mixer, side]);

  useEffect(() => {
    if (!nativeDeck || !stemLocalPaths) return;
    let cancelled = false;
    setLoadedStems({ vocals: false, instrumental: false });
    void nativeMixer.loadStems(side, STEM_IDS.map(stem => stemLocalPaths[stem]), nativeRequestIdRef.current)
      .then(() => {
        if (!cancelled) setLoadedStems({ vocals: true, instrumental: true });
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load separated stems into the native mixer.');
      });
    return () => { cancelled = true; };
  }, [nativeDeck, stemLocalPaths, nativeMixer, side]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!ready) return;
    if (playing) {
      if (nativeDeck) {
        try {
          await nativeMixer.pause(side);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Could not pause native playback.');
        }
      } else {
        pauseAllAudio();
      }
      return;
    }
    try {
      if (nativeDeck) {
        await nativeMixer.play(side);
        setError('');
        return;
      }
      if (!audio) return;
      if (stemsEnabled) {
        const elements = getStemElements();
        if (!elements || !stemsReady) throw new Error('Wait for both UVR stems to finish loading.');
        for (const stem of STEM_IDS) {
          elements[stem].currentTime = audio.currentTime;
          elements[stem].playbackRate = audio.playbackRate;
        }
        await mixer.playStems(side, audio, elements);
      } else {
        await mixer.play(side, audio);
      }
      setError('');
    } catch (reason) {
      if (stemsEnabled) {
        pauseAllAudio();
        setStemsEnabled(false);
        stemsEnabledRef.current = false;
        mixer.setStemMode(side, false);
      }
      setError(reason instanceof Error ? reason.message : 'Could not start playback.');
    }
  };

  const setDeckVolume = (value: number) => {
    setGain(value);
    if (nativeDeck) {
      void nativeMixer.setDeckGain(side, value).catch(reason => {
        setError(reason instanceof Error ? reason.message : 'Could not set native deck level.');
      });
    } else {
      mixer.setDeckGain(side, value);
    }
  };

  const setDeckEqualizer = (band: 'low' | 'mid' | 'high', value: number) => {
    setEqualizer(previous => ({ ...previous, [band]: value }));
    if (nativeDeck) {
      void nativeMixer.setDeckEq(side, band, value).catch(reason => {
        setError(reason instanceof Error ? reason.message : 'Could not update native EQ.');
      });
    } else {
      mixer.setDeckEq(side, band, value);
    }
  };

  const toggleLoop = () => {
    const audio = audioRef.current;
    if (loopRange) {
      if (nativeDeck) {
        void nativeMixer.setLoop(side, null, null).then(() => setLoopRange(null)).catch(reason => {
          setError(reason instanceof Error ? reason.message : 'Could not disable the native loop.');
        });
      } else {
        setLoopRange(null);
      }
      return;
    }
    if ((!nativeDeck && !audio) || !ready || duration <= 0) return;
    const loopLength = getLoopDurationSeconds(track?.bpm, loopBeats, duration);
    if (loopLength <= 0) return;
    const start = Math.min(nativeDeck || stemsEnabled ? position : audio!.currentTime, Math.max(0, duration - loopLength));
    if (nativeDeck) {
      void nativeMixer.seek(side, start)
        .then(() => nativeMixer.setLoop(side, start, start + loopLength))
        .then(() => {
          setPosition(start);
          setLoopRange({ start, end: start + loopLength });
        })
        .catch(reason => setError(reason instanceof Error ? reason.message : 'Could not start the native loop.'));
      return;
    }
    audio!.currentTime = start;
    for (const element of Object.values(stemAudioRefs.current)) if (element) element.currentTime = start;
    setPosition(start);
    setLoopRange({ start, end: start + loopLength });
  };

  const updateLoopBeats = (beats: LoopBeatCount) => {
    setLoopBeats(beats);
    if (!loopRange || !track?.bpm) return;
    const audio = audioRef.current;
    if ((!nativeDeck && !audio) || duration <= 0) return;
    const loopLength = getLoopDurationSeconds(track.bpm, beats, duration);
    const start = Math.min(nativeDeck || stemsEnabled ? position : audio!.currentTime, Math.max(0, duration - loopLength));
    if (nativeDeck) {
      void nativeMixer.seek(side, start)
        .then(() => nativeMixer.setLoop(side, start, start + loopLength))
        .then(() => {
          setPosition(start);
          setLoopRange({ start, end: start + loopLength });
        })
        .catch(reason => setError(reason instanceof Error ? reason.message : 'Could not update the native loop.'));
      return;
    }
    audio!.currentTime = start;
    for (const element of Object.values(stemAudioRefs.current)) if (element) element.currentTime = start;
    setPosition(start);
    setLoopRange({ start, end: start + loopLength });
  };

  const setDeckPitch = (value: number) => {
    setPitch(value);
    if (nativeDeck) {
      void nativeMixer.setTempo(side, 1 + value / 100).catch(reason => {
        setError(reason instanceof Error ? reason.message : 'Could not update native tempo.');
      });
      return;
    }
    if (audioRef.current) audioRef.current.playbackRate = 1 + value / 100;
    for (const element of Object.values(stemAudioRefs.current)) {
      if (element) element.playbackRate = 1 + value / 100;
    }
  };

  const returnToCue = () => {
    const audio = audioRef.current;
    if (nativeDeck) {
      void nativeMixer.returnToCue(side).then(() => {
        setPlaying(false);
        setPosition(cuePosition);
      }).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not return to native cue.'));
      return;
    }
    if (!audio) return;
    pauseAllAudio();
    audio.currentTime = cuePosition;
    for (const element of Object.values(stemAudioRefs.current)) {
      if (element) element.currentTime = cuePosition;
    }
    setPosition(cuePosition);
  };

  const setCueHere = () => {
    if (nativeDeck) {
      void nativeMixer.setCue(side, position).then(() => setCuePosition(position)).catch(reason => {
        setError(reason instanceof Error ? reason.message : 'Could not set native cue point.');
      });
      return;
    }
    const audio = stemsEnabled ? getStemElements()?.vocals : audioRef.current;
    if (!audio || !ready) return;
    setCuePosition(audio.currentTime);
  };
  const toggleStemPlayback = async () => {
    if (nativeDeck) {
      if (stemsEnabled) {
        try {
          await nativeMixer.pause(side);
          await nativeMixer.setStemsEnabled(side, false);
          setStemsEnabled(false);
          stemsEnabledRef.current = false;
          setPlaying(false);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Could not disable native stem playback.');
        }
        return;
      }
      if (!stemsReady) return;
      try {
        await nativeMixer.setStemsEnabled(side, true);
        setStemsEnabled(true);
        stemsEnabledRef.current = true;
        await nativeMixer.play(side);
        setPlaying(true);
        setError('');
      } catch (reason) {
        setStemsEnabled(false);
        stemsEnabledRef.current = false;
        void nativeMixer.setStemsEnabled(side, false).catch(() => {});
        setError(reason instanceof Error ? reason.message : 'Could not start native stem playback.');
      }
      return;
    }
    if (stemsEnabled) {
      pauseAllAudio();
      setStemsEnabled(false);
      stemsEnabledRef.current = false;
      mixer.setStemMode(side, false);
      if (audioRef.current) audioRef.current.currentTime = position;
      return;
    }
    if (!stemsReady) return;
    pauseAllAudio();
    const audio = audioRef.current;
    const elements = getStemElements();
    if (!audio || !elements) return;
    for (const stem of STEM_IDS) {
      elements[stem].currentTime = position;
      elements[stem].playbackRate = audio.playbackRate;
    }
    setStemsEnabled(true);
    stemsEnabledRef.current = true;
    mixer.setStemMode(side, true);
    try {
      await mixer.playStems(side, audio, elements);
      setError('');
    } catch (reason) {
      pauseAllAudio();
      setStemsEnabled(false);
      stemsEnabledRef.current = false;
      mixer.setStemMode(side, false);
      setError(reason instanceof Error ? reason.message : 'Could not start the separated stems.');
    }
  };
  const updateStemLevel = (stem: StemId, value: number) => {
    setStemLevels(previous => ({ ...previous, [stem]: value }));
    if (nativeDeck) {
      void nativeMixer.setStemGain(side, stem, value).catch(reason => {
        setError(reason instanceof Error ? reason.message : 'Could not update native stem level.');
      });
    } else {
      mixer.setStemGain(side, stem, value);
    }
  };
  const startSeparation = async () => {
    if (!desktopRuntime || !track || !stemCompatibility?.compatible || (!nativeDeck && !managedAudioAvailable)) return;
    const jobId = crypto.randomUUID();
    separationJobRef.current = jobId;
    setSeparationJobId(jobId);
    setSeparationProgress({ percent: 0, message: 'Starting model…' });
    setError('');
    let unlisten = () => {};
    try {
      unlisten = await listen<StemSeparationEvent>('stem-separation', event => {
        const progress = event.payload;
        if (progress.jobId !== jobId) return;
        setSeparationProgress({ percent: progress.percent, message: progress.message });
        if (progress.status === 'complete' && progress.stems) {
          const urls = Object.fromEntries(
            STEM_IDS.map(stem => [stem, convertFileSrc(progress.stems![stem])]),
          ) as StemPaths;
          const unchanged = stemSourcesRef.current
            && STEM_IDS.every(stem => stemSourcesRef.current?.[stem] === urls[stem]);
          if (!unchanged) {
            if (stemsEnabledRef.current) {
              for (const element of Object.values(stemAudioRefs.current)) element?.pause();
              setStemsEnabled(false);
              stemsEnabledRef.current = false;
              if (nativeDeck) {
                void nativeMixer.setStemsEnabled(side, false).catch(() => {});
              } else {
                mixer.setStemMode(side, false);
              }
            }
            stemSourcesRef.current = urls;
            setStemLocalPaths(progress.stems);
            setStemSources(urls);
          }
          setLoadedStems({ vocals: false, instrumental: false });
          setSeparationProgress({ percent: 100, message: 'Ready.' });
          setSeparationJobId('');
          separationJobRef.current = '';
          void unlisten();
          unlistenSeparationRef.current = null;
        } else if (progress.status === 'cancelled') {
          setSeparationJobId('');
          separationJobRef.current = '';
          setSeparationProgress({ percent: 0, message: 'Separation cancelled.' });
          void unlisten();
          unlistenSeparationRef.current = null;
        } else if (progress.status === 'error') {
          setError(progress.error || progress.message || 'Separation failed.');
          setSeparationJobId('');
          separationJobRef.current = '';
          void unlisten();
          unlistenSeparationRef.current = null;
        }
      });
      unlistenSeparationRef.current = unlisten;
    } catch (reason) {
      separationJobRef.current = '';
      setSeparationJobId('');
      setError(reason instanceof Error ? reason.message : 'Could not listen for separation updates.');
      return;
    }
    try {
      if (nativeDeck && track.filePath) {
        await invoke('start_stem_separation', {
          jobId,
          trackPath: track.filePath,
          modelChoice: stemSettings.modelChoice,
          overlap: stemSettings.overlap,
        });
      } else {
        const importedAudio = await loadDesktopImportedAudioTrack(track.id, invoke);
        if (!importedAudio) throw new Error('The saved local audio file is missing. Re-import it to continue.');
        if (separationJobRef.current !== jobId) return;
        await invoke('start_stem_separation_from_audio', {
          jobId,
          fileName: track.fileName ?? track.title,
          audioBytes: Array.from(new Uint8Array(await importedAudio.arrayBuffer())),
          modelChoice: stemSettings.modelChoice,
          overlap: stemSettings.overlap,
        });
      }
    } catch (reason) {
      void unlisten();
      unlistenSeparationRef.current = null;
      separationJobRef.current = '';
      setSeparationJobId('');
        setError(reason instanceof Error ? reason.message : 'Could not start separation.');
    }
  };

  const cancelSeparation = async () => {
    if (!separationJobId) return;
    try {
      await invoke('cancel_stem_separation', { jobId: separationJobId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not cancel separation.');
    }
  };
  const midiControlsRef = useRef({
    play: () => {},
    cue: () => {},
    gain: (_value: number) => {},
  });
  midiControlsRef.current = {
    play: () => { void togglePlayback(); },
    cue: returnToCue,
    gain: setDeckVolume,
  };

  useEffect(() => {
    const receiveMidi = (event: Event) => {
      const detail = (event as CustomEvent<MidiActionDetail>).detail;
      if (!detail) return;
      if (detail.action === `deck-${side}-play`) midiControlsRef.current.play();
      if (detail.action === `deck-${side}-cue`) midiControlsRef.current.cue();
      if (detail.action === `deck-${side}-gain`) midiControlsRef.current.gain(detail.value);
    };
    window.addEventListener(MIDI_ACTION_EVENT, receiveMidi);
    return () => window.removeEventListener(MIDI_ACTION_EVENT, receiveMidi);
  }, [side]);

  return (
    <section className={`panel-line overflow-hidden rounded-xl border-t-2 ${sideBorder}`}>
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className={`grid h-9 w-9 place-items-center rounded-lg bg-secondary ${sideColor}`}><Disc3 size={19} className={playing ? 'animate-spin' : ''} /></div>
          <div><div className={`font-mono-ui text-[10px] uppercase tracking-[.18em] ${sideColor}`}>Deck {sideName}</div><div className="mt-0.5 text-[10px] text-muted-foreground">{playing ? 'Playing' : loading ? 'Loading audio' : ready ? 'Ready' : 'Stopped'}</div></div>
        </div>
        <div className="font-mono-ui text-[11px] text-muted-foreground">{formatTime(position)} / {formatTime(duration)}</div>
      </div>

      <div className="space-y-5 p-5">
        <label className="block">
          <span className="mb-1.5 block font-mono-ui text-[9px] uppercase tracking-[.16em] text-muted-foreground">Load from library</span>
          <select
            value={trackId}
            onChange={event => setTrackId(event.target.value)}
            aria-label={`Load a track to deck ${sideName}`}
            data-testid={`select-track-deck-${side}`}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-[11px] outline-none focus:border-primary"
          >
            <option value="">Choose a playable track…</option>
            {playableTracks.map(item => <option key={item.id} value={item.id}>{item.artist ? `${item.artist} — ` : ''}{item.title}</option>)}
          </select>
        </label>

        <div className="flex min-h-[82px] items-center gap-3 rounded-lg border border-border/80 bg-card/60 px-4 py-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-secondary text-primary"><Music2 size={17} /></div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-lg font-semibold">{track?.title ?? 'Empty deck'}</div>
            <div className="truncate text-[10px] text-muted-foreground">{track?.artist || (track ? track.fileName : 'Choose a track above to load audio')}</div>
          </div>
          {track && <div className="font-mono-ui text-[10px] text-muted-foreground">{track.bpm ? `${track.bpm} BPM` : 'BPM —'}</div>}
        </div>

        <label className="block">
          <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>Position</span><span className="font-mono-ui">{formatTime(position)}</span></div>
          <input
            aria-label={`Seek deck ${sideName}`}
            data-testid={`input-seek-deck-${side}`}
            type="range"
            min="0"
            max={Math.max(duration, 0)}
            step="0.05"
            value={Math.min(position, duration)}
            disabled={!ready || duration <= 0}
            onChange={event => {
              const nextPosition = Number(event.target.value);
              if (nativeDeck) {
                void nativeMixer.seek(side, nextPosition).catch(reason => {
                  setError(reason instanceof Error ? reason.message : 'Could not seek in native playback.');
                });
              } else {
                if (audioRef.current) audioRef.current.currentTime = nextPosition;
                for (const element of Object.values(stemAudioRefs.current)) {
                  if (element) element.currentTime = nextPosition;
                }
              }
              setPosition(nextPosition);
            }}
            className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={togglePlayback} disabled={!ready} data-testid={`button-play-deck-${side}`} className="flex min-w-[118px] items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-[11px] font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">
            {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? 'Pause' : 'Play'}
          </button>
          <button onClick={returnToCue} disabled={!ready} data-testid={`button-cue-deck-${side}`} className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-[11px] font-semibold hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40">
            <RotateCcw size={13} /> Cue or return
          </button>
          <button onClick={setCueHere} disabled={!ready} data-testid={`button-set-cue-deck-${side}`} className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-[11px] font-semibold hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40">
            Set cue · {formatTime(cuePosition)}
          </button>
          <label className="flex items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted-foreground">
            <span className="sr-only">Loop length</span>
            <select aria-label={`Loop length deck ${sideName}`} data-testid={`select-loop-beats-${side}`} title={track?.bpm ? 'Beat-synced loop length' : 'Set or analyze BPM to enable beat-synced lengths'} value={loopBeats} onChange={event => updateLoopBeats(Number(event.target.value) as LoopBeatCount)} disabled={!ready || !track?.bpm} className="h-9 bg-background text-[10px] outline-none disabled:cursor-not-allowed disabled:opacity-50">
              {LOOP_BEAT_COUNTS.map(beats => <option key={beats} value={beats}>{beats} {beats === 1 ? 'beat' : 'beats'}</option>)}
            </select>
          </label>
          <button onClick={toggleLoop} disabled={!ready} aria-pressed={Boolean(loopRange)} data-testid={`button-loop-deck-${side}`} className={`flex items-center gap-2 rounded-md border px-3 py-2.5 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${loopRange ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/50'}`}>
            <Repeat2 size={13} /> {loopRange ? `Looping · ${track?.bpm ? `${loopBeats} beat${loopBeats === 1 ? '' : 's'}` : '4s'}` : track?.bpm ? `${loopBeats}-beat loop` : '4s loop'}
          </button>
          <span className="ml-auto font-mono-ui text-[10px] text-muted-foreground">{loading ? 'Loading…' : loopRange ? `${(loopRange.end - loopRange.start).toFixed(2)}s loop active` : ready ? 'Source ready' : 'No audio loaded'}</span>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><Volume2 size={13} /> Deck level</span><span className="font-mono-ui text-foreground">{Math.round(gain * 100)}%</span></div>
            <input aria-label={`Deck ${sideName} level`} data-testid={`input-gain-deck-${side}`} type="range" min="0" max="1" step="0.01" value={gain} onChange={event => setDeckVolume(Number(event.target.value))} className="h-2 w-full cursor-pointer accent-primary" />
          </label>
          <label className="block">
            <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>Tempo</span><span className="font-mono-ui text-foreground">{pitch > 0 ? '+' : ''}{pitch.toFixed(1)}%</span></div>
            <input aria-label={`Deck ${sideName} tempo`} data-testid={`input-tempo-deck-${side}`} type="range" min="-8" max="8" step="0.1" value={pitch} onChange={event => setDeckPitch(Number(event.target.value))} className="h-2 w-full cursor-pointer accent-primary" />
          </label>
          {(['low', 'mid', 'high'] as const).map(band => (
            <label key={band} className="block">
              <div className="mb-2 flex items-center justify-between text-[10px] capitalize text-muted-foreground"><span>{band} EQ</span><span className="font-mono-ui text-foreground">{equalizer[band] > 0 ? '+' : ''}{equalizer[band]} dB</span></div>
              <input aria-label={`Deck ${sideName} ${band} EQ`} data-testid={`input-eq-${band}-deck-${side}`} type="range" min="-12" max="12" step="0.5" value={equalizer[band]} onChange={event => setDeckEqualizer(band, Number(event.target.value))} className="h-2 w-full cursor-pointer accent-primary" />
            </label>
          ))}
        </div>
        <div className="rounded-lg border border-border/80 bg-card/40 p-4">
          {analysis?.waveform?.length ? (
            <div className="mb-4" data-testid={`analysis-waveform-${side}`}>
              <div className="mb-2 flex items-center justify-between font-mono-ui text-[9px] uppercase tracking-[.14em] text-muted-foreground">
                <span>Waveform preview</span>
                <span>{analysis.beatGridSeconds?.length ?? 0} detected beats</span>
              </div>
              <div className="relative flex h-12 items-center gap-px overflow-hidden rounded bg-secondary/60 px-1" aria-label="Waveform envelope">
                {analysis.waveform.map((amplitude, index) => (
                  <span
                    key={index}
                    className="min-w-px flex-1 rounded-sm bg-primary/70"
                    style={{ height: `${Math.max(3, amplitude * 100)}%` }}
                  />
                ))}
                {analysis.beatGridSeconds?.map((beat, index) => {
                  const beatPosition = duration > 0 ? (beat / duration) * 100 : 0;
                  return beatPosition >= 0 && beatPosition <= 100 ? (
                    <span key={`beat-${index}`} className="absolute top-0 h-full w-px bg-accent/80" style={{ left: `${beatPosition}%` }} />
                  ) : null;
                })}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-primary">Offline separation</div>
              <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
                {stemSources
                  ? 'Vocals and instrumental are ready.'
                  : desktopRuntime
                    ? 'Run the verified UVR model on this track. It stays local; first separation may download 59 MB and take several minutes.'
                    : 'Open this track in the desktop app to separate it with the configured model.'}
              </p>
            </div>
            {separationJobId ? (
              <button onClick={() => void cancelSeparation()} className="rounded-md border border-border px-3 py-2 text-[10px] font-semibold hover:border-destructive/50 hover:text-destructive">
                Cancel separation
              </button>
            ) : desktopRuntime && stemCompatibility?.compatible && track && (nativeDeck || managedAudioAvailable) ? (
              <button onClick={() => void startSeparation()} data-testid={`button-separate-deck-${side}`} className="rounded-md bg-secondary px-3 py-2 text-[10px] font-semibold hover:bg-secondary/70">
                {stemSources ? 'Separate with current model' : 'Separate vocals + instrumental'}
              </button>
            ) : null}
          </div>
          {separationJobId && (
            <div className="mt-3" role="status" aria-live="polite">
              <div className="mb-1 flex justify-between gap-3 text-[9px] text-muted-foreground">
                <span>{separationProgress.message}</span><span className="font-mono-ui">{separationProgress.percent}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary transition-[width]" style={{ width: `${separationProgress.percent}%` }} />
              </div>
            </div>
          )}
          {desktopRuntime && !stemCompatibility?.compatible && (
            <p className="mt-2 text-[9px] leading-4 text-muted-foreground">Select and verify a compatible model above before separation is available.</p>
          )}
          {stemSources && (
            <div className="mt-3">
              <StemMixerControls
                deckName={sideName}
                enabled={stemsEnabled}
                ready={stemsReady}
                levels={stemLevels}
                onToggle={() => void toggleStemPlayback()}
                onLevelChange={updateStemLevel}
              />
              {!stemsReady && <p role="status" className="mt-2 text-[9px] text-muted-foreground">Loading the cached vocals and instrumental stems…</p>}
            </div>
          )}
          {desktopRuntime && stemLocalPaths && (
            <div className="mt-3 rounded-md border border-border/70 bg-background/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-primary">Intro / outro extension unavailable</div>
                  <p className="mt-1 max-w-[420px] text-[9px] leading-4 text-muted-foreground">
                    UVR HQ 5 returns vocals and instrumental only. This tool needs separate drums, bass, and other stems.
                  </p>
                </div>
                <button
                  disabled
                  data-testid={`button-extend-song-deck-${side}`}
                  className="rounded-md bg-secondary px-3 py-2.5 text-[10px] font-semibold text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  title="Requires a four-stem separation model"
                >
                  Requires four stems
                </button>
              </div>
            </div>
          )}
          {separationProgress.message && !separationJobId && (
            <p role="status" className="mt-2 text-[9px] text-muted-foreground">{separationProgress.message}</p>
          )}
        </div>
        {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[10px] leading-4 text-destructive">{error}</p>}
      </div>
      <audio ref={audioRef} className="hidden" crossOrigin="anonymous" preload="metadata" />
      {STEM_IDS.map(stem => (
        <audio
          key={stem}
          ref={element => { stemAudioRefs.current[stem] = element; }}
          className="hidden"
          preload="auto"
          src={nativeDeck ? undefined : stemSources?.[stem]}
        />
      ))}
    </section>
  );
}