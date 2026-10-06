import type { StemId } from '@/lib/audio-mixer';
import { Volume2 } from 'lucide-react';

export const STEM_IDS: StemId[] = ['vocals', 'instrumental'];

export function StemMixerControls({
  deckName,
  enabled,
  ready,
  levels,
  onToggle,
  onLevelChange,
}: {
  deckName: string;
  enabled: boolean;
  ready: boolean;
  levels: Record<StemId, number>;
  onToggle: () => void;
  onLevelChange: (stem: StemId, value: number) => void;
}) {
  return (
    <section className="rounded-lg border border-primary/20 bg-primary/[.035] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-primary">UVR two-stem mix</h3>
          <p className="mt-1 text-[9px] text-muted-foreground">Vocals and instrumental remain sample-aligned.</p>
        </div>
        <button
          onClick={onToggle}
          disabled={!ready}
          aria-pressed={enabled}
          data-testid={`button-stems-toggle-${deckName.toLowerCase()}`}
          className={`rounded-md border px-3 py-2 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${enabled ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/50'}`}
        >
          {enabled ? 'Use full mix' : `Use stems on Deck ${deckName}`}
        </button>
      </div>
      {enabled && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {STEM_IDS.map(stem => (
            <label key={stem} className="block rounded-md border border-border/70 bg-background/60 px-3 py-2">
              <div className="mb-2 flex items-center justify-between text-[10px] capitalize text-muted-foreground">
                <span className="flex items-center gap-1.5"><Volume2 size={12} /> {stem}</span>
                <span className="font-mono-ui text-foreground">{Math.round(levels[stem] * 100)}%</span>
              </div>
              <input
                aria-label={`${stem} stem level deck ${deckName}`}
                data-testid={`input-stem-${stem}-deck-${deckName.toLowerCase()}`}
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={levels[stem]}
                onChange={event => onLevelChange(stem, Number(event.target.value))}
                className="h-2 w-full cursor-pointer accent-primary"
              />
            </label>
          ))}
        </div>
      )}
    </section>
  );
}