import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface ModelDownloadState {
  status: 'idle' | 'downloading' | 'ready' | 'error';
  percent: number;
  message: string;
}

interface DownloadEvent {
  jobId: string;
  percent: number;
  message: string;
}

const idle: ModelDownloadState = { status: 'idle', percent: 0, message: '' };
const states = new Map<string, ModelDownloadState>();
const activeDownloads = new Map<string, Promise<void>>();
const subscribers = new Set<() => void>();

function update(modelChoice: string, state: ModelDownloadState) {
  states.set(modelChoice, state);
  subscribers.forEach(notify => notify());
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

export function useStemModelDownload(modelChoice: string) {
  return useSyncExternalStore(subscribe, () => states.get(modelChoice) ?? idle);
}

export function downloadModelWeights(modelChoice: string): Promise<void> {
  const active = activeDownloads.get(modelChoice);
  if (active) return active;
  if (states.get(modelChoice)?.status === 'ready') return Promise.resolve();

  const jobId = crypto.randomUUID();
  update(modelChoice, { status: 'downloading', percent: 0, message: 'Preparing model download…' });
  const task = (async () => {
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<DownloadEvent>('stem-model-download', event => {
        if (event.payload.jobId !== jobId) return;
        update(modelChoice, {
          status: 'downloading',
          percent: Math.max(0, Math.min(100, event.payload.percent)),
          message: event.payload.message,
        });
      });
      await invoke('download_stem_model', { jobId, modelChoice });
      update(modelChoice, {
        status: 'ready', percent: 100,
        message: 'Selected model weights are ready locally. No download is needed for separation.',
      });
    } catch (reason) {
      update(modelChoice, {
        status: 'error', percent: states.get(modelChoice)?.percent ?? 0,
        message: typeof reason === 'string' ? reason
          : reason instanceof Error ? reason.message : 'Could not download the selected model weights.',
      });
    } finally {
      unlisten?.();
      activeDownloads.delete(modelChoice);
    }
  })();
  activeDownloads.set(modelChoice, task);
  return task;
}
