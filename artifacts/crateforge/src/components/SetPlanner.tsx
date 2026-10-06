import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download, ListMusic, Plus, Trash2 } from 'lucide-react';
import type { Crate, Track } from '@/lib/local-library';
import { downloadTextFile, exportCrateM3u } from '@/lib/local-library';
import { explainTransition, planSet, type EnergyArc, type SetPlanOptions } from '@/lib/set-planner';
import { formatKeyWithCamelot } from '@/lib/camelot';

const templates: Record<string, SetPlanOptions> = {
  Cocktail: { durationMinutes: 90, startBpm: 100, endBpm: 114, arc: 'plateau' },
  Wedding: { durationMinutes: 180, startBpm: 92, endBpm: 126, arc: 'wave' },
  Club: { durationMinutes: 120, startBpm: 118, endBpm: 130, arc: 'steady-rise' },
  Corporate: { durationMinutes: 120, startBpm: 100, endBpm: 122, arc: 'plateau' },
  'School dance': { durationMinutes: 150, startBpm: 90, endBpm: 126, arc: 'wave' },
  Festival: { durationMinutes: 60, startBpm: 120, endBpm: 132, arc: 'peak-and-valley' },
  Radio: { durationMinutes: 60, startBpm: 105, endBpm: 125, arc: 'steady-rise' },
};

const createId = () => `set-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
const createdNow = () => new Date().toISOString();

interface SetPlannerProps {
  tracks: Track[];
  savedSets: Crate[];
  onSaveSet: (set: Crate) => void;
  onDeleteSet: (id: string) => void;
  onSelectTrack: (id: string) => void;
  onImport: () => void;
}

export function SetPlanner({ tracks, savedSets, onSaveSet, onDeleteSet, onSelectTrack, onImport }: SetPlannerProps) {
  const [name, setName] = useState('New gig set');
  const [templateName, setTemplateName] = useState('Wedding');
  const [options, setOptions] = useState<SetPlanOptions>(templates.Wedding);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [planTracks, setPlanTracks] = useState<Track[]>([]);
  const [status, setStatus] = useState('');
  const trackById = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks]);
  const activeSet = savedSets.find(set => set.id === activeSetId);
  const missingReferences = activeSet
    ? activeSet.trackIds.filter(id => !trackById.has(id)).length
    : 0;

  const chooseTemplate = (value: string) => {
    setTemplateName(value);
    setOptions(templates[value] ?? templates.Wedding);
    if (!activeSet) setName(`${value} set`);
  };

  const build = () => {
    const result = planSet(tracks, options);
    setPlanTracks(result.tracks);
    setActiveSetId(null);
    setStatus(result.tracks.length
      ? result.complete
        ? `Built a ${Math.round(result.plannedSeconds / 60)} minute set suggestion. Review the order before saving.`
        : `The library covers ${Math.round(result.plannedSeconds / 60)} of ${Math.round(result.targetSeconds / 60)} requested minutes. Add more tracks or shorten the set.`
      : 'No tracks with a known duration are available to build a set.');
  };

  const openSavedSet = (set: Crate) => {
    setActiveSetId(set.id);
    setName(set.name);
    setPlanTracks(set.trackIds.flatMap(id => {
      const track = trackById.get(id);
      return track ? [track] : [];
    }));
    setStatus(set.trackIds.length
      ? `Opened saved set with ${set.trackIds.length} tracks${set.trackIds.length > 0 ? '.' : ''}`
      : 'This saved set is empty.');
  };

  const save = () => {
    if (!planTracks.length) {
      setStatus('Build a set or open a saved set before saving.');
      return;
    }
    const previous = activeSet;
    const next: Crate = {
      id: previous?.id ?? createId(),
      name: name.trim() || `${templateName} set`,
       color: previous?.color ?? '#22C55E',
      trackIds: planTracks.map(track => track.id),
      kind: 'set',
      createdAt: previous?.createdAt ?? createdNow(),
      updatedAt: createdNow(),
    };
    onSaveSet(next);
    setActiveSetId(next.id);
    setStatus(`Saved “${next.name}”.`);
  };

  const removeFromPlan = (trackId: string) => setPlanTracks(previous => previous.filter(track => track.id !== trackId));
  const moveTrack = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= planTracks.length) return;
    setPlanTracks(previous => {
      const next = [...previous];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const exportCurrent = () => {
    if (!planTracks.length) return;
    const crate: Crate = {
      id: activeSetId ?? 'set-preview',
      name: name.trim() || 'Drop Theory set',
       color: activeSet?.color ?? '#22C55E',
      trackIds: planTracks.map(track => track.id),
      kind: 'set',
      createdAt: activeSet?.createdAt ?? createdNow(),
      updatedAt: createdNow(),
    };
    downloadTextFile(
      `${crate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'drop-theory-set'}.m3u8`,
      exportCrateM3u(crate, tracks),
      'audio/x-mpegurl;charset=utf-8',
    );
    setStatus('Playlist exported as an M3U8 file. No DJ software database was changed.');
  };

  const totalSeconds = planTracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0);
  const targetSeconds = Math.max(1, options.durationMinutes * 60);

  return (
    <div className="reveal space-y-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.2em] text-primary">Gig preparation</div>
          <h1 className="font-display text-4xl font-semibold tracking-[-.055em]">Prep a set</h1>
          <p className="mt-2 max-w-2xl text-[12px] leading-5 text-muted-foreground">Build an editable set from your library using BPM, key, energy, rating, and track duration.</p>
        </div>
      </div>

      {!tracks.length ? (
        <section className="panel-line rounded-xl p-8 text-center">
          <ListMusic className="mx-auto mb-3 text-primary" size={24} />
          <h2 className="font-display text-xl font-semibold">Add tracks before planning a set</h2>
          <p className="mt-2 text-xs text-muted-foreground">The planner needs track metadata and durations. It does not use streaming audio.</p>
          <button onClick={onImport} data-testid="button-import-for-set" className="mt-5 rounded-md bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground">Import tracks</button>
        </section>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <section className="panel-line rounded-xl p-4">
              <div className="mb-4 flex items-center gap-2"><ListMusic size={15} className="text-primary" /><h2 className="font-display text-base font-semibold">Set builder</h2></div>
              <label className="mb-3 block space-y-1.5">
                <span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Gig template</span>
                <select value={templateName} onChange={event => chooseTemplate(event.target.value)} data-testid="select-set-template" className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs">
                  {Object.keys(templates).map(template => <option key={template} value={template}>{template}</option>)}
                </select>
              </label>
              <label className="mb-3 block space-y-1.5">
                <span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Set name</span>
                <input value={name} onChange={event => setName(event.target.value)} data-testid="input-set-name" className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs" />
              </label>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <label className="space-y-1.5">
                  <span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Minutes</span>
                  <input type="number" min="10" max="480" step="5" value={options.durationMinutes} onChange={event => setOptions(previous => ({ ...previous, durationMinutes: Math.max(10, Math.min(480, Number(event.target.value) || 10)) }))} data-testid="input-set-duration" className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs" />
                </label>
                <label className="space-y-1.5">
                  <span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Energy arc</span>
                  <select value={options.arc} onChange={event => setOptions(previous => ({ ...previous, arc: event.target.value as EnergyArc }))} data-testid="select-set-energy-arc" className="h-9 w-full rounded-md border border-border bg-background px-2 text-[10px]">
                    <option value="steady-rise">Steady rise</option>
                    <option value="wave">Wave</option>
                    <option value="peak-and-valley">Peak & valley</option>
                    <option value="plateau">Plateau</option>
                  </select>
                </label>
              </div>
              <div className="mb-4 grid grid-cols-2 gap-2">
                <label className="space-y-1.5">
                  <span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Start BPM</span>
                  <input type="number" min="60" max="200" value={options.startBpm} onChange={event => setOptions(previous => ({ ...previous, startBpm: Number(event.target.value) || 60 }))} data-testid="input-set-start-bpm" className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs" />
                </label>
                <label className="space-y-1.5">
                  <span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">End BPM</span>
                  <input type="number" min="60" max="200" value={options.endBpm} onChange={event => setOptions(previous => ({ ...previous, endBpm: Number(event.target.value) || 60 }))} data-testid="input-set-end-bpm" className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs" />
                </label>
              </div>
               <button onClick={build} data-testid="button-build-set" className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 text-xs font-bold text-primary-foreground"><ListMusic size={14} /> Build set</button>
              <p className="mt-3 text-[10px] leading-4 text-muted-foreground">The order is a starting point, not an audio compatibility guarantee. Clean/explicit rules and locked tracks need their own metadata and are not inferred.</p>
            </section>

            <section className="panel-line rounded-xl p-4">
              <div className="mb-3 flex items-center justify-between"><h2 className="font-display text-base font-semibold">Saved sets</h2><span className="font-mono-ui text-[9px] text-muted-foreground">{savedSets.length}</span></div>
              {savedSets.length ? <div className="space-y-1.5">
                {savedSets.map(set => <div key={set.id} className={`flex items-center gap-1 rounded-md ${set.id === activeSetId ? 'bg-secondary' : ''}`}>
                  <button onClick={() => openSavedSet(set)} data-testid={`button-open-set-${set.id}`} className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[11px] font-medium hover:text-primary">{set.name}<span className="ml-2 font-mono-ui text-[9px] text-muted-foreground">{set.trackIds.length} tracks</span></button>
                  <button onClick={() => { if (window.confirm(`Delete saved set “${set.name}”? The library tracks will stay unchanged.`)) { onDeleteSet(set.id); if (activeSetId === set.id) { setActiveSetId(null); setPlanTracks([]); } } }} aria-label={`Delete saved set ${set.name}`} data-testid={`button-delete-set-${set.id}`} className="rounded p-2 text-muted-foreground hover:text-destructive"><Trash2 size={13} /></button>
                </div>)}
              </div> : <p className="text-[10px] leading-4 text-muted-foreground">Save a reviewed plan to keep it beside your crates.</p>}
            </section>
          </aside>

          <section className="panel-line min-w-0 overflow-hidden rounded-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
              <div>
                <h2 className="font-display text-lg font-semibold">{activeSet?.name ?? name}</h2>
                <p className="mt-1 text-[10px] text-muted-foreground">{planTracks.length} tracks · {Math.floor(totalSeconds / 60)}:{String(Math.floor(totalSeconds % 60)).padStart(2, '0')} planned · target {options.durationMinutes} min</p>
              </div>
              <div className="flex gap-2">
                <button onClick={save} disabled={!planTracks.length} data-testid="button-save-set" className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-[10px] font-bold hover:border-primary/50 disabled:opacity-40"><Plus size={13} /> Save set</button>
                <button onClick={exportCurrent} disabled={!planTracks.length} data-testid="button-export-set" className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[10px] font-bold text-primary-foreground disabled:opacity-40"><Download size={13} /> Export M3U8</button>
              </div>
            </div>
            {planTracks.length > 0 && (
              <div className="border-b border-border px-4 py-3 sm:px-5">
                <div className="mb-1 flex justify-between font-mono-ui text-[9px] text-muted-foreground"><span>Set coverage</span><span>{Math.min(100, Math.round((totalSeconds / targetSeconds) * 100))}%</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, (totalSeconds / targetSeconds) * 100)}%` }} /></div>
              </div>
            )}
            {missingReferences > 0 && <div role="status" className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-[10px] text-amber-200">{missingReferences} saved track reference{missingReferences === 1 ? '' : 's'} are unavailable in this library.</div>}
            <div className="divide-y divide-border/70">
              {planTracks.map((track, index) => {
                const previous = planTracks[index - 1];
                return <div key={`${track.id}-${index}`} data-testid={`row-set-track-${track.id}`} className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-5">
                  <span className="w-6 shrink-0 text-center font-mono-ui text-[9px] text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                  <button onClick={() => onSelectTrack(track.id)} data-testid={`button-inspect-set-track-${track.id}`} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[11px] font-semibold">{track.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{track.artist} · {track.bpm ?? '—'} BPM · {formatKeyWithCamelot(track.key) ?? 'key unknown'} · energy {track.energy ?? '—'}</span>
                    {previous && <span className="mt-1 block text-[9px] leading-4 text-primary/80">Why next: {explainTransition(previous, track)}</span>}
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button onClick={() => moveTrack(index, -1)} disabled={index === 0} aria-label={`Move ${track.title} up`} data-testid={`button-move-set-track-up-${track.id}`} className="rounded p-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowUp size={13} /></button>
                    <button onClick={() => moveTrack(index, 1)} disabled={index === planTracks.length - 1} aria-label={`Move ${track.title} down`} data-testid={`button-move-set-track-down-${track.id}`} className="rounded p-1.5 text-muted-foreground hover:bg-secondary disabled:opacity-30"><ArrowDown size={13} /></button>
                    <button onClick={() => removeFromPlan(track.id)} aria-label={`Remove ${track.title} from set`} data-testid={`button-remove-set-track-${track.id}`} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={13} /></button>
                  </div>
                </div>;
              })}
              {!planTracks.length && <div className="p-10 text-center text-[11px] text-muted-foreground">Build a suggestion or open a saved set to review its order.</div>}
            </div>
            {status && <p role="status" data-testid="status-set-planner" className="border-t border-border px-4 py-3 text-[10px] leading-4 text-muted-foreground sm:px-5">{status}</p>}
          </section>
        </div>
      )}
    </div>
  );
}