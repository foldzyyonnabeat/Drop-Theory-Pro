import type { MouseEventHandler } from 'react';
import { Disc3, Maximize2, Minus, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

async function runWindowAction(label: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    console.error(`Could not ${label} the Drop Theory Pro window.`, error);
  }
}

export function WindowChrome() {
  const currentWindow = getCurrentWindow();
  const toggleMaximize = () => runWindowAction('maximize or restore', () => currentWindow.toggleMaximize());
  const handleDoubleClick: MouseEventHandler<HTMLDivElement> = event => {
    if (event.target instanceof HTMLElement && event.target.closest('button')) return;
    void toggleMaximize();
  };

  return (
    <div
      className="window-chrome"
      role="toolbar"
      aria-label="Drop Theory Pro window controls"
      onDoubleClick={handleDoubleClick}
    >
      <div className="window-chrome__leading">
        <div className="window-chrome__traffic-lights" aria-label="Window controls">
          <button
            type="button"
            data-compact="true"
            className="window-chrome__button window-chrome__button--close"
            aria-label="Close window"
            title="Close"
            onClick={() => { void runWindowAction('close', () => currentWindow.close()); }}
          >
            <span className="window-chrome__button-dot"><X size={8} strokeWidth={3} aria-hidden="true" /></span>
          </button>
          <button
            type="button"
            data-compact="true"
            className="window-chrome__button window-chrome__button--minimize"
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => { void runWindowAction('minimize', () => currentWindow.minimize()); }}
          >
            <span className="window-chrome__button-dot"><Minus size={8} strokeWidth={3} aria-hidden="true" /></span>
          </button>
          <button
            type="button"
            data-compact="true"
            className="window-chrome__button window-chrome__button--maximize"
            aria-label="Maximize or restore window"
            title="Maximize or restore"
            onClick={() => { void toggleMaximize(); }}
          >
            <span className="window-chrome__button-dot"><Maximize2 size={7} strokeWidth={3} aria-hidden="true" /></span>
          </button>
        </div>

        <div className="window-chrome__identity" data-tauri-drag-region>
          <span className="window-chrome__brand-mark"><Disc3 size={15} strokeWidth={1.8} aria-hidden="true" /></span>
          <span className="window-chrome__app-name">Drop Theory Pro</span>
        </div>
      </div>

      <div className="window-chrome__drag-region" data-tauri-drag-region aria-hidden="true">
        <span className="window-chrome__drag-grip" />
      </div>

      <div className="window-chrome__trailing" data-tauri-drag-region aria-hidden="true">
        <span className="window-chrome__status-dot" />
        <span>PRIVATE · LOCAL</span>
        <span className="window-chrome__divider" />
        <span>DESKTOP</span>
      </div>
    </div>
  );
}