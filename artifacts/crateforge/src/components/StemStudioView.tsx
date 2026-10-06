import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Download,
  FileAudio2,
  Music2,
  Pause,
  Radio,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import type { Track } from '@/lib/local-library';
import type { StemId } from '@/lib/audio-mixer';
import {
  StemModelSetup,
  type StemModelCompatibility,
  type StemModelSettings,
} from '@/components/StemModelSetup';

export interface StemStudioViewProps {
  tracks: Track[];
  importedAudioTrackIds: ReadonlySet<string>;
  desktopRuntime: boolean;
  missingNativePaths: ReadonlySet<string>;
  selectedTrackId: string;
  selectedTrack: Track | null;
  onTrackChange(id: string): void;
  onImport(): void;
  stemCompatibility: StemModelCompatibility | null;
  onConfigurationChange(settings: StemModelSettings, compatibility: StemModelCompatibility | null): void;
  separationBusy: boolean;
  separationProgress: { percent: number; message: string };
  stemPaths: Record<StemId, string> | null;
  selectedStems: StemId[];
  onToggleStem(stem: StemId): void;
  onSeparate(): void;
  onCancel(): void;
  canSeparate: boolean;
  exportBusy: boolean;
  onExportSelected(): void;
  exportStatus: string;
  error: string;
}

const STEMS: { id: StemId; label: string; detail: string; tone: string }[] = [
  { id: 'vocals', label: 'Vocals', detail: 'Lead & backing', tone: 'text-rose-300' },
  { id: 'instrumental', label: 'Instrumental', detail: 'Music without vocals', tone: 'text-sky-300' },
];

function formatTrackName(track: Track) {
  return `${track.artist ? `${track.artist} — ` : ''}${track.title}`;
}

export function StemStudioView({
  tracks,
  importedAudioTrackIds,
  desktopRuntime,
  missingNativePaths,
  selectedTrackId,
  selectedTrack,
  onTrackChange,
  onImport,
  stemCompatibility,
  onConfigurationChange,
  separationBusy,
  separationProgress,
  stemPaths,
  selectedStems,
  onToggleStem,
  onSeparate,
  onCancel,
  canSeparate,
  exportBusy,
  onExportSelected,
  exportStatus,
  error,
}: StemStudioViewProps) {
  const selectedMissing = Boolean(selectedTrack?.filePath && missingNativePaths.has(selectedTrack.filePath));
  const selectedHasImportedAudio = Boolean(selectedTrack && importedAudioTrackIds.has(selectedTrack.id));
  const selectedNeedsDesktopPath = Boolean(
    desktopRuntime && selectedTrack && !selectedHasImportedAudio && !selectedTrack.filePath,
  );
  const selectedUnavailable = selectedNeedsDesktopPath
    || (desktopRuntime && selectedMissing && !selectedHasImportedAudio);
  const hasStemFiles = Boolean(stemPaths);
  const canExport = desktopRuntime && hasStemFiles && selectedStems.length > 0 && !exportBusy;
  const displayedBpm = selectedTrack?.bpm ?? selectedTrack?.analysis?.bpm ?? null;

  return (
    <div className="reveal mx-auto max-w-[1280px] space-y-5" data-testid="stem-studio-view">
      <header className="flex flex-col justify-between gap-5 border-b border-border pb-5 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.19em] text-primary">
            <Radio size={13} /> Performance tools <span className="text-muted-foreground/50">/</span> 02
          </div>
          <h1 className="font-display text-4xl font-semibold tracking-[-.06em] sm:text-[42px]">Stem Studio</h1>
          <p className="mt-2 max-w-xl text-[12px] leading-5 text-muted-foreground">
            Separate vocals and instrumental locally with the UVR MDX-Net model. Files stay on this device.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start rounded-md border border-border bg-card/60 px-3 py-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground sm:self-auto">
          <span className={`h-1.5 w-1.5 rounded-full ${desktopRuntime ? 'bg-primary' : 'bg-accent'}`} />
          {desktopRuntime ? 'Local runtime' : 'Browser workspace'}
        </div>
      </header>

      {!desktopRuntime && (
        <div role="status" data-testid="status-stem-browser-unavailable" className="flex gap-3 rounded-lg border border-accent/25 bg-accent/[.07] px-4 py-3.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <p className="text-[11px] font-semibold text-foreground">Desktop processing is unavailable here</p>
            <p className="mt-1 text-[10px] leading-5 text-muted-foreground">
              Stem separation, audio export, and native save dialogs run only in the Drop Theory Pro desktop app. This browser view will not start processing.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" data-testid="status-stem-error" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[11px] leading-5 text-destructive">
          {error}
        </div>
      )}

      <section className="panel-line rounded-xl p-4 sm:p-5" aria-labelledby="stem-track-title">
        <div className="flex flex-col gap-4 md:flex-row md:items-end">
          <label className="min-w-0 flex-1" htmlFor="stem-track-select">
            <span id="stem-track-title" className="mb-2 block font-mono-ui text-[9px] uppercase tracking-[.16em] text-muted-foreground">Source track</span>
            <span className="relative block">
              <select
                id="stem-track-select"
                data-testid="select-stem-track"
                value={selectedTrackId}
                onChange={event => onTrackChange(event.target.value)}
                className="h-11 w-full appearance-none rounded-lg border border-border bg-background px-3 pr-10 text-[12px] text-foreground outline-none transition-colors hover:border-primary/40 focus:border-primary"
              >
                <option value="">Choose a track from your library</option>
                {tracks.map(track => {
                  const sourceMissing = Boolean(desktopRuntime && track.filePath && missingNativePaths.has(track.filePath));
                  const hasImportedAudio = importedAudioTrackIds.has(track.id);
                  const needsDesktopPath = Boolean(desktopRuntime && !hasImportedAudio && !track.filePath);
                  const availability = sourceMissing
                    ? hasImportedAudio ? '' : ' — source file missing'
                    : needsDesktopPath
                      ? ' — re-import to process'
                      : '';
                  return (
                    <option key={track.id} value={track.id}>
                      {formatTrackName(track)}{availability}
                    </option>
                  );
                })}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            </span>
          </label>
          <button
            type="button"
            data-testid="button-stem-import"
            onClick={onImport}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-border px-4 text-[11px] font-semibold text-foreground transition-colors hover:border-primary/50 hover:bg-secondary"
          >
            <Music2 size={14} /> Import audio
          </button>
        </div>
        {selectedTrack ? (
          <div data-testid="status-stem-selected-track" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-2 text-foreground"><FileAudio2 size={13} className="shrink-0 text-primary" /><span className="truncate">{selectedTrack.fileName || selectedTrack.title}</span></span>
            {displayedBpm !== null && <span className="font-mono-ui">{displayedBpm} BPM</span>}
            {selectedMissing && !selectedHasImportedAudio && <span className="text-destructive">Source file is missing. Reconnect the drive or re-import the audio to continue.</span>}
            {selectedNeedsDesktopPath && <span className="text-accent">Re-import this audio file in the desktop app to enable separation.</span>}
          </div>
        ) : (
          <p data-testid="status-stem-no-track" className="mt-3 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
            Select an audio-backed track to prepare stems.
          </p>
        )}
      </section>

      <StemModelSetup desktopRuntime={desktopRuntime} onConfigurationChange={onConfigurationChange} />

      <section className="panel-line overflow-hidden rounded-xl" aria-labelledby="separation-title">
        <div className="flex flex-col justify-between gap-4 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:px-5">
          <div>
            <div className="mb-1 flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.15em] text-primary"><Cpu size={12} /> Separation</div>
            <h2 id="separation-title" className="font-display text-xl font-semibold tracking-[-.03em]">Split the source into two stems</h2>
          </div>
          <div className="max-w-sm">
            <p className="text-[10px] leading-5 text-muted-foreground">
              Every run creates synchronized vocals and instrumental stems. Choose which parts to include in the export below.
            </p>
            {stemCompatibility && (
              <p role={stemCompatibility.compatible ? 'status' : 'alert'} data-testid="status-stem-runtime-compatibility" className={`mt-1 text-[9px] leading-4 ${stemCompatibility.compatible ? 'text-primary' : 'text-destructive'}`}>
                {stemCompatibility.compatible ? 'Runtime ready' : 'Runtime needs attention'} · {stemCompatibility.message}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4">
          {STEMS.map((stem, index) => {
            const chosen = selectedStems.includes(stem.id);
            const ready = Boolean(stemPaths?.[stem.id]);
            return (
              <button
                key={stem.id}
                type="button"
                aria-pressed={chosen}
                data-testid={`toggle-stem-${stem.id}`}
                onClick={() => onToggleStem(stem.id)}
                className={`group flex min-h-[66px] items-center gap-3 rounded-lg border px-3 text-left transition-colors ${
                  chosen ? 'border-primary/45 bg-primary/[.08]' : 'border-border bg-background/50 hover:border-primary/30'
                }`}
              >
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md bg-secondary ${stem.tone}`}>
                  {ready ? <CheckCircle2 size={16} /> : <span className="font-mono-ui text-[10px]">{String(index + 1).padStart(2, '0')}</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-semibold">{stem.label}</span>
                  <span className="mt-0.5 block text-[9px] text-muted-foreground">{ready ? 'Stem ready' : stem.detail}</span>
                </span>
                <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded border ${chosen ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-transparent'}`}>
                  <Check size={12} strokeWidth={3} />
                </span>
              </button>
            );
          })}
        </div>

        {separationBusy && (
          <div role="status" data-testid="status-stem-separation-progress" className="mx-4 mb-4 rounded-lg border border-primary/20 bg-primary/[.05] p-3 sm:mx-5">
            <div className="mb-2 flex items-center justify-between gap-3 text-[10px]">
              <span className="min-w-0 truncate text-foreground">{separationProgress.message || 'Separating audio locally…'}</span>
              <span className="shrink-0 font-mono-ui text-primary">{Math.max(0, Math.min(100, Math.round(separationProgress.percent)))}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, separationProgress.percent))}%` }} />
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-border bg-background/35 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p data-testid="status-stem-separation-result" role="status" className="text-[10px] leading-5 text-muted-foreground">
            {hasStemFiles ? 'Vocals and instrumental are ready. Select the parts you want to export.' : 'Source audio is processed locally; the original track remains unchanged.'}
          </p>
          {separationBusy ? (
            <button type="button" data-testid="button-cancel-separation" onClick={onCancel} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-destructive/35 px-4 text-[10px] font-bold text-destructive transition-colors hover:bg-destructive/10">
              <Pause size={13} /> Cancel separation
            </button>
          ) : (
            <button
              type="button"
              data-testid="button-separate-stems"
              onClick={onSeparate}
              disabled={!desktopRuntime || !canSeparate || !selectedTrack || selectedUnavailable}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[10px] font-bold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles size={14} /> Separate vocals + instrumental
            </button>
          )}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
        <div className="panel-line flex flex-col rounded-xl p-4 sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.15em] text-accent"><Download size={12} /> Export</div>
              <h2 className="font-display text-xl font-semibold tracking-[-.03em]">Selected stems</h2>
            </div>
            <span className="rounded-md border border-border bg-background px-2 py-1 font-mono-ui text-[9px] text-muted-foreground">{selectedStems.length} selected</span>
          </div>
          <p className="mb-5 text-[10px] leading-5 text-muted-foreground">
            Export only the checked stems. Each file stays aligned to the same source timeline.
          </p>
          <button
            type="button"
            data-testid="button-export-selected-stems"
            onClick={onExportSelected}
            disabled={!canExport}
            className="mt-auto inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-primary/35 bg-primary/[.08] text-[10px] font-bold text-primary transition-colors hover:bg-primary/[.14] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download size={14} /> {exportBusy ? 'Preparing download…' : 'Download selected stems'}
          </button>
          <p role="status" data-testid="status-stem-export" className="mt-3 min-h-4 text-[10px] leading-4 text-muted-foreground">
            {exportStatus || (hasStemFiles ? 'Export destination is chosen in the desktop app.' : 'Separate the track before exporting stems.')}
          </p>
        </div>

        <div className="panel-line rounded-xl p-4 sm:p-5">
          <div className="mb-1 flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.15em] text-accent"><WandSparkles size={12} /> Arrangement tool</div>
          <h2 className="font-display text-xl font-semibold tracking-[-.03em]">Intro / outro extension</h2>
          <p className="mt-2 text-[10px] leading-5 text-muted-foreground">
            Unavailable with the selected UVR model. This tool needs separate drums, bass, and other stems; UVR HQ 5 returns vocals and instrumental only.
          </p>
          <div className="mt-4 rounded-lg border border-border bg-background/50 px-3 py-3 text-[10px] leading-5 text-muted-foreground">
            The extension tool stays disabled rather than treating the instrumental stem as drums or bass.
          </div>
        </div>
      </section>
    </div>
  );
}