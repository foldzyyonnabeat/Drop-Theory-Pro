import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, Cpu, Download, RefreshCw } from 'lucide-react';
import { downloadModelWeights, useStemModelDownload } from '@/lib/stem-model-download';

export type StemModelChoice = 'uvr-mdx-inst-hq-5';
export type UvrOverlap = 0.25 | 0.5 | 0.75 | 0.99;

export interface StemModelSettings {
  modelChoice: StemModelChoice;
  overlap: UvrOverlap;
}

export interface StemModelCompatibility {
  compatible: boolean;
  message: string;
  modelsBundled: boolean;
  modelsCached?: boolean;
  modelId: string | null;
  modelLicense: string | null;
  weightsLicense: string | null;
  runtimeVersion: string | null;
  executionProvider: string | null;
}

interface SavedStemSettings {
  modelChoice?: string | null;
  overlap?: number | null;
}

const MODELS: {
  id: StemModelChoice;
  title: string;
  detail: string;
  size: string;
  badge: string;
}[] = [
  {
    id: 'uvr-mdx-inst-hq-5',
    title: 'UVR MDX-Net Inst HQ 5',
    detail: 'Official UVR ONNX model; it predicts instrumental and vocals are calculated as source minus output. UVR has no HQ5-specific FFT metadata, so this uses its documented custom-ONNX 6144 FFT default, 1024 hop, and neutral compensation.',
    size: '59.1 MB · vocals + instrumental',
    badge: 'Local separation',
  },
];

function isModelChoice(value: string | null | undefined): value is StemModelChoice {
  return MODELS.some(model => model.id === value);
}

function isUvrOverlap(value: number | null | undefined): value is UvrOverlap {
  return value === 0.25 || value === 0.5 || value === 0.75 || value === 0.99;
}

const compatibilityChecks = new Map<StemModelChoice, Promise<StemModelCompatibility>>();

function inspectModel(modelChoice: StemModelChoice, refresh = false) {
  if (refresh) compatibilityChecks.delete(modelChoice);
  const cached = compatibilityChecks.get(modelChoice);
  if (cached) return cached;

  const request = invoke<StemModelCompatibility>('inspect_stem_model', { modelChoice });
  compatibilityChecks.set(modelChoice, request);
  return request;
}

export function StemModelSetup({
  desktopRuntime,
  onConfigurationChange,
}: {
  desktopRuntime: boolean;
  onConfigurationChange: (settings: StemModelSettings, compatibility: StemModelCompatibility | null) => void;
}) {
  const [settings, setSettings] = useState<StemModelSettings>({
    modelChoice: 'uvr-mdx-inst-hq-5',
    overlap: 0.25,
  });
  const settingsRef = useRef(settings);
  const [compatibility, setCompatibility] = useState<StemModelCompatibility | null>(null);
  const [checking, setChecking] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const modelDownload = useStemModelDownload(settings.modelChoice);
  const downloading = modelDownload.status === 'downloading';
  const weightsReady = compatibility?.modelsBundled || compatibility?.modelsCached || modelDownload.status === 'ready';
  const checkSequence = useRef(0);
  const onConfigurationChangeRef = useRef(onConfigurationChange);

  useEffect(() => {
    onConfigurationChangeRef.current = onConfigurationChange;
  }, [onConfigurationChange]);

  useEffect(() => {
    if (!desktopRuntime) {
      setSettingsLoaded(false);
      setCompatibility(null);
      return;
    }
    let cancelled = false;
    invoke<SavedStemSettings>('load_stem_settings')
      .then(saved => {
        if (cancelled) return;
        const next: StemModelSettings = {
          modelChoice: isModelChoice(saved.modelChoice) ? saved.modelChoice : 'uvr-mdx-inst-hq-5',
          overlap: isUvrOverlap(saved.overlap) ? saved.overlap : 0.25,
        };
        settingsRef.current = next;
        setSettings(next);
        setSettingsLoaded(true);
        onConfigurationChangeRef.current(next, null);
      })
      .catch(() => {
        if (cancelled) return;
        const defaults: StemModelSettings = {
          modelChoice: 'uvr-mdx-inst-hq-5',
          overlap: 0.25,
        };
        settingsRef.current = defaults;
        setSettings(defaults);
        setSettingsLoaded(true);
        onConfigurationChangeRef.current(defaults, null);
      });
    return () => {
      cancelled = true;
      checkSequence.current++;
    };
  }, [desktopRuntime]);

  const checkCompatibility = async (modelChoice: StemModelChoice, refresh = false) => {
    const sequence = ++checkSequence.current;
    setChecking(true);
    setCompatibility(null);
    setRuntimeMessage('');
    try {
      const result = await inspectModel(modelChoice, refresh);
      if (sequence !== checkSequence.current) return;
      const selection = { modelChoice, overlap: settingsRef.current.overlap };
      setCompatibility(result);
      onConfigurationChangeRef.current(selection, result);
      setRuntimeMessage(result.message);
    } catch (reason) {
      if (sequence !== checkSequence.current) return;
      const selection = { modelChoice, overlap: settingsRef.current.overlap };
      const result: StemModelCompatibility = {
        compatible: false,
        message:
          typeof reason === 'string'
            ? reason
            : reason instanceof Error
              ? reason.message
              : 'Could not check the bundled runtime.',
        modelsBundled: false,
        modelId: null,
        modelLicense: null,
        weightsLicense: null,
        runtimeVersion: null,
        executionProvider: null,
      };
      setCompatibility(result);
      onConfigurationChangeRef.current(selection, result);
      setRuntimeMessage(result.message);
    } finally {
      if (sequence === checkSequence.current) setChecking(false);
    }
  };

  useEffect(() => {
    if (!desktopRuntime || !settingsLoaded) return;
    void checkCompatibility(settings.modelChoice);
  }, [desktopRuntime, settingsLoaded, settings.modelChoice]);

  const updateOverlap = async (overlap: UvrOverlap) => {
    const next = { ...settings, overlap };
    settingsRef.current = next;
    setSettings(next);
    onConfigurationChangeRef.current(next, compatibility);
    try {
      await invoke('save_stem_settings', { settings: next });
    } catch (reason) {
      setRuntimeMessage(reason instanceof Error ? reason.message : 'Could not save the overlap setting.');
    }
  };

  const selectedModel = MODELS.find(model => model.id === settings.modelChoice) ?? MODELS[0];

  return (
    <section className="panel-line rounded-xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.16em] text-primary">
            <Cpu size={13} /> UVR stem separation
          </div>
          <h2 className="font-display text-xl font-semibold">UVR model and settings</h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-5 text-muted-foreground">
            The desktop runtime separates locally. Compatible Windows GPUs use DirectML; CPU inference is available as a fallback. This model creates vocals and instrumental only.
          </p>
        </div>
        {compatibility?.compatible && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[10px] text-primary">
            <CheckCircle2 size={13} /> {weightsReady ? 'Runtime + models ready' : 'Runtime ready'}
          </span>
        )}
      </div>

      {!desktopRuntime ? (
        <p className="mt-4 rounded-lg border border-border bg-card/60 px-3 py-2.5 text-[10px] leading-5 text-muted-foreground">
          Model setup and separation are available in the Drop Theory Pro desktop app. The browser version cannot access native files or start the local runtime.
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-3">
            {MODELS.map(model => (
              <div
                key={model.id}
                className="rounded-lg border border-primary/50 bg-primary/[.07] p-3"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-display text-sm font-semibold">{model.title}</span>
                  <CheckCircle2 size={14} className="shrink-0 text-primary" />
                </span>
                <span className="mt-1 block text-[9px] font-semibold uppercase tracking-[.12em] text-primary">{model.badge}</span>
                <span className="mt-2 block text-[10px] leading-4 text-muted-foreground">{model.detail}</span>
                <span className="mt-2 block font-mono-ui text-[9px] text-muted-foreground">{model.size}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono-ui uppercase tracking-[.12em]">Overlap</span>
              <select
                aria-label="UVR chunk overlap"
                value={settings.overlap}
                onChange={event => void updateOverlap(Number(event.target.value) as UvrOverlap)}
                disabled={downloading}
                className="h-9 rounded-md border border-border bg-background px-2 text-[10px] text-foreground outline-none focus:border-primary"
              >
                <option value={0.25}>25% · faster</option>
                <option value={0.5}>50%</option>
                <option value={0.75}>75%</option>
                <option value={0.99}>99% · slowest</option>
              </select>
            </label>
            <button
              onClick={() => void checkCompatibility(settings.modelChoice, true)}
              disabled={checking || downloading}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[10px] font-semibold hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
              {checking ? 'Checking UVR model and runtime…' : 'Check model and runtime'}
            </button>
            {!compatibility?.modelsBundled && (
              <button
                onClick={() => void downloadModelWeights(settings.modelChoice)}
                disabled={!compatibility?.compatible || checking || downloading || weightsReady}
                className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-[10px] font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Download size={12} />
                {downloading ? 'Downloading model weights…'
                  : weightsReady ? 'Model weights downloaded'
                  : modelDownload.status === 'error' ? 'Retry model download' : 'Download model weights'}
              </button>
            )}
            {compatibility && (
              <span role={compatibility.compatible ? 'status' : 'alert'} className={`text-[10px] leading-5 ${compatibility.compatible ? 'text-primary' : 'text-destructive'}`}>
                {compatibility.message}
                {compatibility.compatible && ` · ${compatibility.executionProvider === 'DmlExecutionProvider' ? 'DirectML provider (GPU when compatible)' : 'CPU provider'} · ${compatibility.modelId} · model ${compatibility.modelLicense} · weights ${compatibility.weightsLicense} · ONNX Runtime ${compatibility.runtimeVersion}`}
              </span>
            )}
          </div>
          {modelDownload.status !== 'idle' && (
            <div className="mt-3" role={modelDownload.status === 'error' ? 'alert' : 'status'}>
              <p className={`text-[10px] leading-5 ${modelDownload.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {modelDownload.message}
              </p>
              {downloading && (
                <div
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="Model weight download"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={modelDownload.percent}
                >
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${modelDownload.percent}%` }} />
                </div>
              )}
            </div>
          )}
          <p role="status" className="mt-2 text-[9px] leading-4 text-muted-foreground">
            {runtimeMessage && runtimeMessage !== compatibility?.message ? runtimeMessage : (compatibility?.modelsBundled
              ? `Selected: ${selectedModel.title}. Its verified weights are included in this offline bundle; no model download is needed.`
              : weightsReady
                ? `Selected: ${selectedModel.title}. Its verified weights are saved in the local cache.`
                : `Selected: ${selectedModel.title}. Download the 59.1 MB model now, or let the first separation download it. Later runs use the local cache.`)}
          </p>
          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            The model is SHA-256 verified and either included in the offline bundle or downloaded to this device; your audio is never uploaded. UVR requests attribution and lists MIT terms in its{' '}
            <a
              href="https://github.com/Anjok07/ultimatevocalremovergui"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-primary"
            >
              project README
            </a>
            .
          </p>
        </>
      )}
    </section>
  );
}