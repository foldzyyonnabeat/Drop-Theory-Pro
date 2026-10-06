export type DeckId = 'a' | 'b';
export type StemId = 'vocals' | 'instrumental';
export type EqBand = 'low' | 'mid' | 'high';

export interface NativeAudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface NativeAudioOutputs {
  devices: NativeAudioDevice[];
  selectedDeviceId: string | null;
  selectedDeviceName: string | null;
  error: string | null;
}

export interface NativeDeckStatus {
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number;
  cuePosition: number;
  loopRange: [number, number] | null;
}

export interface NativeAudioStatus {
  outputName: string | null;
  outputError: string | null;
  decks: [NativeDeckStatus, NativeDeckStatus];
}

type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class NativeAudioMixer {
  constructor(private readonly invokeNative: NativeInvoke) {}

  getOutputs(): Promise<NativeAudioOutputs> {
    return this.invokeNative('get_native_audio_outputs');
  }

  selectOutput(deviceId: string): Promise<NativeAudioOutputs> {
    return this.invokeNative('set_native_audio_output', { deviceId });
  }

  getStatus(): Promise<NativeAudioStatus> {
    return this.invokeNative('get_native_audio_status');
  }

  loadTrack(deck: DeckId, path: string, requestId: string): Promise<NativeDeckStatus> {
    return this.invokeNative('load_native_deck', { deck, path, requestId });
  }

  loadStems(deck: DeckId, paths: string[], requestId: string): Promise<void> {
    return this.invokeNative('load_native_stems', { deck, paths, requestId });
  }

  unloadDeck(deck: DeckId): Promise<void> {
    return this.invokeNative('unload_native_deck', { deck });
  }

  play(deck: DeckId): Promise<void> {
    return this.invokeNative('play_native_deck', { deck });
  }

  pause(deck: DeckId): Promise<void> {
    return this.invokeNative('pause_native_deck', { deck });
  }

  seek(deck: DeckId, position: number): Promise<void> {
    return this.invokeNative('seek_native_deck', { deck, position });
  }

  setCue(deck: DeckId, position: number): Promise<void> {
    return this.invokeNative('set_native_cue', { deck, position });
  }

  returnToCue(deck: DeckId): Promise<void> {
    return this.invokeNative('return_native_to_cue', { deck });
  }

  setLoop(deck: DeckId, start: number | null, end: number | null): Promise<void> {
    return this.invokeNative('set_native_loop', { deck, start, end });
  }

  setTempo(deck: DeckId, rate: number): Promise<void> {
    return this.invokeNative('set_native_tempo', { deck, rate });
  }

  setDeckGain(deck: DeckId, gain: number): Promise<void> {
    return this.invokeNative('set_native_deck_gain', { deck, gain });
  }

  setDeckEq(deck: DeckId, band: EqBand, decibels: number): Promise<void> {
    return this.invokeNative('set_native_deck_eq', { deck, band, decibels });
  }

  setCrossfader(position: number): Promise<void> {
    return this.invokeNative('set_native_crossfader', { position });
  }

  setMasterGain(gain: number): Promise<void> {
    return this.invokeNative('set_native_master_gain', { gain });
  }

  setStemsEnabled(deck: DeckId, enabled: boolean): Promise<void> {
    return this.invokeNative('set_native_stems_enabled', { deck, enabled });
  }

  setStemGain(deck: DeckId, stem: StemId, gain: number): Promise<void> {
    return this.invokeNative('set_native_stem_gain', { deck, stem, gain });
  }
}

export function crossfaderGains(position: number): { a: number; b: number } {
  const normalized = Math.max(0, Math.min(1, position));
  const angle = normalized * Math.PI / 2;
  return { a: Math.cos(angle), b: Math.sin(angle) };
}

interface AudioChannelGraph {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
}

interface DeckGraph extends AudioChannelGraph {
  stems: Map<StemId, AudioChannelGraph>;
}

export class LocalAudioMixer {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private decks = new Map<DeckId, DeckGraph>();
  private crossfader = 0.5;
  private deckGains: Record<DeckId, number> = { a: 1, b: 1 };
  private stemMode: Record<DeckId, boolean> = { a: false, b: false };
  private stemGains: Record<DeckId, Record<StemId, number>> = {
    a: { vocals: 1, instrumental: 1 },
    b: { vocals: 1, instrumental: 1 },
  };
  private equalizer: Record<DeckId, { low: number; mid: number; high: number }> = {
    a: { low: 0, mid: 0, high: 0 },
    b: { low: 0, mid: 0, high: 0 },
  };
  private masterGain = 0.82;

  async play(deck: DeckId, element: HTMLAudioElement): Promise<void> {
    this.stemMode[deck] = false;
    const context = this.ensureGraph(deck, element);
    this.applyDeckGains();
    if (context.state === 'suspended') await context.resume();
    await element.play();
  }

  async playStems(
    deck: DeckId,
    element: HTMLAudioElement,
    stems: Record<StemId, HTMLAudioElement>,
  ): Promise<void> {
    const context = this.ensureGraph(deck, element);
    const deckGraph = this.decks.get(deck)!;
    for (const stem of Object.keys(stems) as StemId[]) {
      const elementForStem = stems[stem];
      const existing = deckGraph.stems.get(stem);
      if (existing && existing.element !== elementForStem) {
        throw new Error('A stem audio element changed unexpectedly. Reload Drop Theory Pro and try again.');
      }
      if (!existing) {
        deckGraph.stems.set(stem, this.createAudioGraph(deck, elementForStem));
      }
    }
    this.stemMode[deck] = true;
    this.applyDeckGains();
    if (context.state === 'suspended') await context.resume();
    await Promise.all(Object.values(stems).map(elementForStem => elementForStem.play()));
  }

  setStemMode(deck: DeckId, enabled: boolean): void {
    this.stemMode[deck] = enabled;
    this.applyDeckGains();
  }

  setStemGain(deck: DeckId, stem: StemId, gain: number): void {
    this.stemGains[deck][stem] = Math.max(0, Math.min(1, gain));
    this.applyDeckGains();
  }

  setCrossfader(position: number): void {
    this.crossfader = Math.max(0, Math.min(1, position));
    this.applyDeckGains();
  }

  setDeckGain(deck: DeckId, gain: number): void {
    this.deckGains[deck] = Math.max(0, Math.min(1, gain));
    this.applyDeckGains();
  }

  setDeckEq(deck: DeckId, band: 'low' | 'mid' | 'high', decibels: number): void {
    const value = Math.max(-12, Math.min(12, decibels));
    this.equalizer[deck][band] = value;
    const graph = this.decks.get(deck);
    if (graph && this.context) {
      graph[band].gain.setTargetAtTime(value, this.context.currentTime, 0.025);
      for (const stem of graph.stems.values()) {
        stem[band].gain.setTargetAtTime(value, this.context.currentTime, 0.025);
      }
    }
  }

  setMasterGain(gain: number): void {
    this.masterGain = Math.max(0, Math.min(1, gain));
    if (this.master && this.context) this.ramp(this.master.gain, this.masterGain);
  }

  async dispose(): Promise<void> {
    for (const deck of this.decks.values()) {
      this.disconnectChannel(deck);
      for (const stem of deck.stems.values()) this.disconnectChannel(stem);
    }
    this.decks.clear();
    this.master?.disconnect();
    this.limiter?.disconnect();
    this.master = null;
    this.limiter = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }

  private ensureGraph(deck: DeckId, element: HTMLAudioElement): AudioContext {
    if (!this.context) {
      if (!window.AudioContext) {
        throw new Error('This browser does not support the audio mixer.');
      }
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.masterGain;
      this.limiter = this.context.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.12;
      this.master.connect(this.limiter);
      this.limiter.connect(this.context.destination);
    }

    const existing = this.decks.get(deck);
    if (existing) {
      if (existing.element !== element) {
        throw new Error('The deck audio element changed unexpectedly. Reload Drop Theory Pro and try again.');
      }
      return this.context;
    }

    const channel = this.createAudioGraph(deck, element);
    this.decks.set(deck, { ...channel, stems: new Map() });
    this.applyDeckGains();
    return this.context;
  }

  private createAudioGraph(deck: DeckId, element: HTMLAudioElement): AudioChannelGraph {
    const source = this.context!.createMediaElementSource(element);
    const low = this.context!.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 250;
    low.gain.value = this.equalizer[deck].low;
    const mid = this.context!.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.8;
    mid.gain.value = this.equalizer[deck].mid;
    const high = this.context!.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 5000;
    high.gain.value = this.equalizer[deck].high;
    const gain = this.context!.createGain();
    source.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(gain);
    gain.connect(this.master!);
    return { element, source, gain, low, mid, high };
  }

  private applyDeckGains(): void {
    for (const [deckId, channel] of this.decks) {
      this.ramp(
        channel.gain.gain,
        this.stemMode[deckId] ? 0 : this.channelGain(deckId),
      );
      for (const [stem, stemChannel] of channel.stems) {
        this.ramp(
          stemChannel.gain.gain,
          this.stemMode[deckId] ? this.channelGain(deckId) * this.stemGains[deckId][stem] : 0,
        );
      }
    }
  }

  private channelGain(deck: DeckId): number {
    const gains = crossfaderGains(this.crossfader);
    const crossfade = deck === 'a' ? gains.a : gains.b;
    return this.deckGains[deck] * crossfade;
  }

  private disconnectChannel(channel: AudioChannelGraph): void {
    channel.source.disconnect();
    channel.low.disconnect();
    channel.mid.disconnect();
    channel.high.disconnect();
    channel.gain.disconnect();
  }

  private ramp(parameter: AudioParam, value: number): void {
    if (!this.context) {
      parameter.value = value;
      return;
    }
    parameter.setTargetAtTime(value, this.context.currentTime, 0.025);
  }
}