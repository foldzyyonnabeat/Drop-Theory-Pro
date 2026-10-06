import { useEffect, useState } from 'react';
import { Activity, CircleHelp, Disc3, Layers3, LibraryBig, ListMusic, LayoutDashboard, Search, ShieldCheck, Split, Upload } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export type WorkspaceTab = 'overview' | 'library' | 'decks' | 'stem-studio' | 'crates' | 'set-prep' | 'health' | 'licenses';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (tab: WorkspaceTab) => void;
  onImport: () => void;
  onDemo: () => void;
  onSearch: (query: string) => void;
}

const navigation = [
  { id: 'overview' as const, label: 'Overview', icon: LayoutDashboard },
  { id: 'library' as const, label: 'Library', icon: LibraryBig },
  { id: 'decks' as const, label: 'Decks', icon: Disc3 },
  { id: 'stem-studio' as const, label: 'Stem Studio', icon: Split },
  { id: 'crates' as const, label: 'Crates', icon: Layers3 },
  { id: 'set-prep' as const, label: 'Prep a set', icon: ListMusic },
  { id: 'health' as const, label: 'Library health', icon: Activity },
  { id: 'licenses' as const, label: 'Licensing & credits', icon: ShieldCheck },
];

export function CommandPalette({ open, onOpenChange, onNavigate, onImport, onDemo, onSearch }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      } else if (event.key === '?' && !isEditing) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpenChange, open]);

  const run = (action: () => void) => {
    action();
    onOpenChange(false);
    setQuery('');
  };

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search tracks or actions…"
          data-testid="input-command-palette"
        />
        <CommandList>
          <CommandEmpty>No matching action. Try a track title or artist.</CommandEmpty>
          {query.trim() && <CommandGroup heading="Search">
            <CommandItem
              value={`search library ${query}`}
              onSelect={() => run(() => onSearch(query.trim()))}
              data-testid="command-search-library"
            >
              <Search />
              <span>Search library for “{query.trim()}”</span>
              <span className="ml-auto text-[10px] text-muted-foreground">Enter</span>
            </CommandItem>
          </CommandGroup>}
          <CommandGroup heading="Go to">
            {navigation.map(({ id, label, icon: Icon }) => <CommandItem
              key={id}
              value={`${label} ${id}`}
              onSelect={() => run(() => onNavigate(id))}
              data-testid={`command-navigate-${id}`}
            >
              <Icon />
              <span>{label}</span>
            </CommandItem>)}
          </CommandGroup>
          <CommandGroup heading="Actions">
            <CommandItem value="import audio files playlists" onSelect={() => run(onImport)} data-testid="command-import">
              <Upload /><span>Import files or playlists</span>
            </CommandItem>
          <CommandItem value="load sample library" onSelect={() => run(onDemo)} data-testid="command-load-demo">
            <ListMusic /><span>Load sample library</span>
            </CommandItem>
            <CommandItem value="keyboard shortcuts help" onSelect={() => { onOpenChange(false); setHelpOpen(true); }} data-testid="command-shortcuts">
              <CircleHelp /><span>Show keyboard shortcuts</span><span className="ml-auto text-[10px] text-muted-foreground">?</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Keyboard shortcuts</DialogTitle>
            <DialogDescription>Shortcuts work while focus is outside an editable field.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-xs">
            <div className="flex justify-between"><span>Open command palette</span><kbd className="rounded border border-border px-1.5 py-0.5 font-mono-ui">Ctrl or Command + K</kbd></div>
            <div className="flex justify-between"><span>Open shortcut help</span><kbd className="rounded border border-border px-1.5 py-0.5 font-mono-ui">?</kbd></div>
            <div className="flex justify-between"><span>Close dialog</span><kbd className="rounded border border-border px-1.5 py-0.5 font-mono-ui">Esc</kbd></div>
            <p className="border-t border-border pt-3 text-[10px] leading-4 text-muted-foreground">Search track names, artists, and available workspace actions.</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}