import { useMemo, useState } from 'react';
import { Download, ExternalLink, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { licenseInventory } from '@/lib/license-inventory.generated';
import { downloadTextFile } from '@/lib/local-library';

type LicenseFilter = 'all' | 'safe' | 'review' | 'blocked';

function category(verdict: string): Exclude<LicenseFilter, 'all'> {
  if (verdict.includes('❌')) return 'blocked';
  if (verdict.includes('⚠️')) return 'review';
  return 'safe';
}

export function LicensesPage() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LicenseFilter>('all');
  const filtered = useMemo(() => licenseInventory.filter(item => {
    const matchesFilter = filter === 'all' || category(item.verdict) === filter;
    const searchable = `${item.name} ${item.version} ${item.license} ${item.verdict}`.toLowerCase();
    return matchesFilter && searchable.includes(query.trim().toLowerCase());
  }), [filter, query]);
  const safeCount = licenseInventory.filter(item => category(item.verdict) === 'safe').length;
  const reviewCount = licenseInventory.filter(item => category(item.verdict) === 'review').length;
  const blockedCount = licenseInventory.filter(item => category(item.verdict) === 'blocked').length;

  const exportInventory = () => {
    const report = [
      'Drop Theory Pro dependency license inventory',
      'Automated metadata only. Verify upstream license files before distribution.',
      '',
      ...licenseInventory.map(item => `${item.verdict} ${item.name}@${item.version} — ${item.license}${item.source ? ` — ${item.source}` : ''}`),
    ].join('\n');
    downloadTextFile('drop-theory-pro-license-inventory.txt', report, 'text/plain;charset=utf-8');
  };

  return (
    <div className="reveal space-y-5">
      <div>
        <div className="mb-2 font-mono-ui text-[10px] uppercase tracking-[.2em] text-primary">Release review</div>
        <h1 className="font-display text-4xl font-semibold tracking-[-.055em]">Licensing & credits</h1>
        <p className="mt-2 max-w-3xl text-[12px] leading-5 text-muted-foreground">Dependency metadata generated from the installed Drop Theory Pro application. This is a review aid, not a legal opinion or proof that a package, model, codec, font, or asset may be distributed.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="panel-line rounded-xl p-4"><span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Permissive metadata</span><div className="mt-2 font-display text-2xl font-semibold">{safeCount}</div><p className="mt-1 text-[10px] text-muted-foreground">Still retain required notices.</p></div>
        <div className="panel-line rounded-xl p-4"><span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Manual review</span><div className="mt-2 font-display text-2xl font-semibold">{reviewCount}</div><p className="mt-1 text-[10px] text-muted-foreground">License metadata needs a human check.</p></div>
        <div className="panel-line rounded-xl p-4"><span className="font-mono-ui text-[9px] uppercase tracking-wider text-muted-foreground">Release blockers</span><div className="mt-2 font-display text-2xl font-semibold">{blockedCount}</div><p className="mt-1 text-[10px] text-muted-foreground">The release check fails if any are present.</p></div>
      </div>

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-[10px] leading-4 text-amber-100">
        <div className="mb-1 flex items-center gap-2 font-semibold"><ShieldAlert size={13} /> Scope and release rule</div>
        This page lists the resolved JavaScript dependencies. The Windows installer also bundles CPython and pinned stem-runtime wheels; their license files and a package list are retained in the installed <code>stem-runtime</code> folder. Model weights, codecs, audio files, fonts, icons, and trademarks are not covered here. Release builds must run <code>pnpm --filter @workspace/crateforge run licenses:check-release</code>; unresolved upstream terms still need review.
      </div>

      <section className="panel-line overflow-hidden rounded-xl">
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a package or license…" data-testid="input-license-search" className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-[11px] outline-none focus:border-primary" />
          </div>
          <select value={filter} onChange={event => setFilter(event.target.value as LicenseFilter)} data-testid="select-license-filter" className="h-9 rounded-md border border-border bg-background px-3 text-[11px]">
            <option value="all">All results</option><option value="safe">Permissive metadata</option><option value="review">Needs review</option><option value="blocked">Release blockers</option>
          </select>
          <button onClick={exportInventory} data-testid="button-export-license-inventory" className="flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-[10px] font-bold hover:border-primary/50"><Download size={13} /> Export list</button>
        </div>
        <div className="max-h-[60vh] overflow-auto divide-y divide-border/70">
          {filtered.map((item, index) => <div key={`${item.name}-${item.version}-${index}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              {item.verdict.includes('✅') ? <ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary" /> : <ShieldAlert size={14} className="mt-0.5 shrink-0 text-amber-300" />}
              <div className="min-w-0">
                <div className="break-all text-[11px] font-semibold">{item.name}<span className="ml-2 font-mono-ui text-[9px] text-muted-foreground">{item.version}</span></div>
                <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{item.note}</div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3 pl-6 sm:pl-0">
              <span className="rounded border border-border px-2 py-1 font-mono-ui text-[9px]">{item.license}</span>
              {item.source && <a href={item.source} target="_blank" rel="noreferrer" aria-label={`Open source for ${item.name}`} className="text-muted-foreground hover:text-primary"><ExternalLink size={13} /></a>}
            </div>
          </div>)}
          {!filtered.length && <div className="p-8 text-center text-[11px] text-muted-foreground">No packages match this filter.</div>}
        </div>
        <div className="border-t border-border px-4 py-2 text-[9px] leading-4 text-muted-foreground">The same generated inventory is available in <code>docs/THIRD_PARTY_NOTICES.md</code> and through the local license inventory command.</div>
      </section>
    </div>
  );
}