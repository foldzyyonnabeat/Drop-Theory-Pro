import { camelotForKey } from '../lib/camelot';

interface AnalyzeRequest {
  type: 'analyze';
  sampleRate: number;
  channels: ArrayBuffer[];
}

interface CancelRequest {
  type: 'cancel';
}

type WorkerRequest = AnalyzeRequest | CancelRequest;

interface AnalysisResult {
  bpm: number | null;
  bpmConfidence: number | null;
  key: string | null;
  camelot: string | null;
  keyConfidence: number | null;
  energy: number | null;
  durationSeconds: number;
  beatGridSeconds: number[];
  waveform: number[];
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

const TARGET_RATE = 11025;
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function downmixAndResample(channels: Float32Array[], sourceRate: number): Float32Array {
  const sourceLength = Math.min(...channels.map(channel => channel.length));
  const stride = sourceRate / TARGET_RATE;
  const output = new Float32Array(Math.floor(sourceLength / stride));
  const channelCount = Math.max(channels.length, 1);

  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * stride);
    const end = Math.min(sourceLength, Math.max(start + 1, Math.floor((i + 1) * stride)));
    let sum = 0;
    let count = 0;
    for (let sample = start; sample < end; sample++) {
      for (const channel of channels) sum += channel[sample] ?? 0;
      count += channelCount;
    }
    output[i] = count ? sum / count : 0;
    if (i % 250000 === 0) workerScope.postMessage({ type: 'progress', progress: 0.15 * i / Math.max(output.length, 1) });
  }
  return output;
}

function estimateEnergy(samples: Float32Array): number | null {
  if (samples.length === 0) return null;
  let squared = 0;
  const stride = Math.max(1, Math.floor(samples.length / 500000));
  let count = 0;
  for (let i = 0; i < samples.length; i += stride) {
    squared += samples[i] * samples[i];
    count++;
  }
  const rms = Math.sqrt(squared / Math.max(count, 1));
  if (rms < 0.00001) return null;
  const decibels = 20 * Math.log10(rms);
  return Math.max(1, Math.min(10, Math.round((decibels + 42) / 4.2)));
}

function estimateBpm(samples: Float32Array): { bpm: number | null; confidence: number | null } {
  const frameSize = 1024;
  const hop = 256;
  const frameCount = Math.floor((samples.length - frameSize) / hop) + 1;
  if (frameCount < 32) return { bpm: null, confidence: null };
  const lowEnergy = new Float32Array(frameCount);
  const highEnergy = new Float32Array(frameCount);
  const lowSquares = new Float32Array(frameSize);
  const highSquares = new Float32Array(frameSize);
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 180 / TARGET_RATE);
  let lowState = 0;
  let lowSum = 0;
  let highSum = 0;
  let frame = 0;

  // Track low- and high-frequency energy independently. Onsets from both
  // bands help avoid mistaking a sustained bass note or bright hi-hat for beats.
  for (let sample = 0; sample < samples.length; sample++) {
    const value = samples[sample];
    lowState += lowAlpha * (value - lowState);
    const low = lowState;
    const high = value - low;
    const slot = sample % frameSize;
    if (sample >= frameSize) {
      lowSum -= lowSquares[slot];
      highSum -= highSquares[slot];
    }
    lowSquares[slot] = low * low;
    highSquares[slot] = high * high;
    lowSum += lowSquares[slot];
    highSum += highSquares[slot];
    if (sample + 1 >= frameSize && (sample + 1 - frameSize) % hop === 0 && frame < frameCount) {
      lowEnergy[frame] = Math.sqrt(Math.max(0, lowSum) / frameSize);
      highEnergy[frame] = Math.sqrt(Math.max(0, highSum) / frameSize);
      frame++;
    }
  }

  const meanLow = lowEnergy.reduce((sum, value) => sum + value, 0) / frameCount;
  const meanHigh = highEnergy.reduce((sum, value) => sum + value, 0) / frameCount;
  if (meanLow + meanHigh < 1e-7) return { bpm: null, confidence: null };
  const rawOnset = new Float32Array(frameCount);
  let meanOnset = 0;
  for (let i = 1; i < frameCount; i++) {
    const lowFlux = meanLow > 1e-8 ? Math.max(0, lowEnergy[i] - lowEnergy[i - 1]) / meanLow : 0;
    const highFlux = meanHigh > 1e-8 ? Math.max(0, highEnergy[i] - highEnergy[i - 1]) / meanHigh : 0;
    rawOnset[i] = lowFlux * 0.65 + highFlux * 0.35;
    meanOnset += rawOnset[i];
  }
  meanOnset /= frameCount;
  const onset = new Float32Array(frameCount);
  for (let i = 1; i < frameCount; i++) onset[i] = Math.max(0, rawOnset[i] - meanOnset * 0.12);

  const framesPerSecond = TARGET_RATE / hop;
  const minLag = Math.max(1, Math.floor(framesPerSecond * 60 / 185));
  const maxLag = Math.min(frameCount - 1, Math.ceil(framesPerSecond * 60 / 55));
  let bestLag = 0;
  let bestScore = 0;
  const scores = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let product = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let i = lag; i < frameCount; i++) {
      const left = onset[i];
      const right = onset[i - lag];
      product += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const score = product / Math.sqrt(leftPower * rightPower || 1);
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore < 0.08) return { bpm: null, confidence: null };
  const peakLags: number[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) peakLags.push(lag);
  }

  const refinePeak = (lag: number) => {
    let refined = lag;
    if (lag > minLag && lag < maxLag) {
      const left = scores[lag - 1];
      const center = scores[lag];
      const right = scores[lag + 1];
      const curvature = left - 2 * center + right;
      if (Math.abs(curvature) > 1e-8) {
        refined += Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature));
      }
    }
    return refined;
  };
  let refinedLag = refinePeak(bestLag);
  let selectedScore = bestScore;
  let bpm = 60 * framesPerSecond / refinedLag;
  // Tempo autocorrelation often has equally strong half-time and double-time
  // peaks. Only promote a slow peak when the faster pulse has substantial
  // support; weaker offbeat accents can otherwise create a confident but
  // incorrect dance-tempo reading.
  if (bpm < 80) {
    const doubleTimeLag = Math.round(refinedLag / 2);
    if (doubleTimeLag >= minLag && scores[doubleTimeLag] >= bestScore * 0.6) {
      refinedLag = refinePeak(doubleTimeLag);
      selectedScore = scores[doubleTimeLag];
      bpm = 60 * framesPerSecond / refinedLag;
    } else {
      // Syncopated patterns can create a strong peak near a dotted or triplet
      // subdivision of the underlying beat. If a nearby candidate is nearly
      // as well supported, use it; if neither interpretation is convincing,
      // decline instead of turning a weak accent into a BPM result.
      const slowerBpm = bpm;
      const relatedPeaks = peakLags
        .map(lag => ({
          lag,
          bpm: 60 * framesPerSecond / refinePeak(lag),
          score: scores[lag],
        }))
        .filter(candidate => {
          const ratio = candidate.bpm / slowerBpm;
          return candidate.bpm >= 80 && candidate.bpm <= 130 && ratio >= 1.25 && ratio <= 1.6;
        })
        .sort((left, right) => right.score - left.score);
      const relatedPeak = relatedPeaks[0];
      if (relatedPeak && relatedPeak.score >= bestScore * 0.25) {
        if (relatedPeak.score < bestScore * 0.8) return { bpm: null, confidence: null };
        refinedLag = refinePeak(relatedPeak.lag);
        selectedScore = relatedPeak.score;
        bpm = 60 * framesPerSecond / refinedLag;
      }
    }
  }
  if (bpm > 185) bpm /= 2;
  if (bpm < 55 || bpm > 185) return { bpm: null, confidence: null };
  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence: Math.round(Math.min(1, selectedScore) * 1000) / 1000,
  };
}

function estimateBeatGrid(samples: Float32Array, bpm: number | null): number[] {
  if (!bpm || samples.length < 512) return [];
  const frameSize = 512;
  const hop = 256;
  const frameCount = Math.floor((samples.length - frameSize) / hop);
  if (frameCount < 2) return [];
  const envelope = new Float32Array(frameCount);
  let mean = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    let energy = 0;
    const start = frame * hop;
    for (let i = 0; i < frameSize; i++) energy += samples[start + i] * samples[start + i];
    envelope[frame] = Math.sqrt(energy / frameSize);
    mean += envelope[frame];
  }
  mean /= frameCount;
  let firstBeatFrame = 0;
  let strongestOnset = 0;
  // Establish phase from the opening bars. Looking across the whole track can
  // anchor the grid near the end when a later accent happens to be louder.
  const phaseSearchFrames = Math.min(frameCount, Math.ceil(TARGET_RATE * 2 / hop));
  for (let frame = 1; frame < phaseSearchFrames; frame++) {
    const onset = Math.max(0, envelope[frame] - envelope[frame - 1] - mean * 0.015);
    if (onset > strongestOnset) {
      strongestOnset = onset;
      firstBeatFrame = frame;
    }
  }
  if (strongestOnset <= 0) return [];
  const framesPerBeat = TARGET_RATE * 60 / (bpm * hop);
  if (!Number.isFinite(framesPerBeat) || framesPerBeat <= 0) return [];
  const duration = samples.length / TARGET_RATE;
  const grid: number[] = [];
  for (let frame = firstBeatFrame; frame * hop / TARGET_RATE < duration && grid.length < 1000; frame += framesPerBeat) {
    grid.push(Math.round((frame * hop / TARGET_RATE) * 1000) / 1000);
  }
  return grid;
}

function makeWaveform(samples: Float32Array): number[] {
  if (samples.length === 0) return [];
  const bins = Math.min(1000, Math.max(1, Math.ceil(samples.length / 2048)));
  const waveform: number[] = [];
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * samples.length / bins);
    const end = Math.max(start + 1, Math.floor((bin + 1) * samples.length / bins));
    let peak = 0;
    for (let index = start; index < Math.min(end, samples.length); index++) peak = Math.max(peak, Math.abs(samples[index]));
    waveform.push(Math.round(Math.min(1, peak) * 1000) / 1000);
  }
  return waveform;
}

function goertzelPower(samples: Float32Array, start: number, length: number, frequency: number, window: Float32Array): number {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / TARGET_RATE);
  let previous = 0;
  let previousPrevious = 0;
  for (let i = 0; i < length; i++) {
    const current = samples[start + i] * window[i] + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return Math.max(0, previous * previous + previousPrevious * previousPrevious - coefficient * previous * previousPrevious);
}

function correlation(a: number[], b: number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let squareA = 0;
  let squareB = 0;
  for (let i = 0; i < a.length; i++) {
    const centeredA = a[i] - meanA;
    const centeredB = b[i] - meanB;
    numerator += centeredA * centeredB;
    squareA += centeredA * centeredA;
    squareB += centeredB * centeredB;
  }
  return numerator / Math.sqrt(squareA * squareB || 1);
}

function estimateKey(samples: Float32Array): { key: string | null; confidence: number | null } {
  const frameSize = 4096;
  if (samples.length < frameSize) return { key: null, confidence: null };
  const chroma = Array.from({ length: 12 }, () => 0);
  const window = Float32Array.from({ length: frameSize }, (_, index) =>
    0.5 - 0.5 * Math.cos(2 * Math.PI * index / (frameSize - 1)),
  );
  const noteFrequencies: Array<{ midi: number; frequency: number }> = [];
  for (let midi = 33; midi <= 84; midi++) {
    noteFrequencies.push({ midi, frequency: 440 * 2 ** ((midi - 69) / 12) });
  }
  const maxFrames = 160;
  const step = Math.max(frameSize, Math.floor((samples.length - frameSize) / maxFrames));
  let framesUsed = 0;

  for (let start = 0; start + frameSize <= samples.length; start += step) {
    const frameChroma = new Float64Array(12);
    for (const note of noteFrequencies) {
      frameChroma[note.midi % 12] += Math.sqrt(goertzelPower(samples, start, frameSize, note.frequency, window));
    }
    const frameTotal = frameChroma.reduce((sum, value) => sum + value, 0);
    if (frameTotal > 1e-8) {
      for (let pitchClass = 0; pitchClass < chroma.length; pitchClass++) {
        chroma[pitchClass] += frameChroma[pitchClass] / frameTotal;
      }
    }
    framesUsed++;
    if (framesUsed >= maxFrames) break;
    if (framesUsed % 10 === 0) workerScope.postMessage({ type: 'progress', progress: 0.15 + 0.75 * framesUsed / maxFrames });
  }

  if (chroma.reduce((sum, value) => sum + value, 0) < 1e-8) return { key: null, confidence: null };
  let bestScore = -Infinity;
  let bestKey: string | null = null;
  let nextBestScore = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]] as const) {
      const rotated = profile.map((_, index) => profile[(index - root + 12) % 12]);
      const score = correlation(chroma, rotated);
      if (score > bestScore) {
        nextBestScore = bestScore;
        bestScore = score;
        bestKey = `${NOTE_NAMES[root]} ${mode}`;
      } else if (score > nextBestScore) {
        nextBestScore = score;
      }
    }
  }
  return {
    key: bestKey,
    confidence: Math.round(Math.max(0, Math.min(1, (bestScore - nextBestScore) * 8)) * 1000) / 1000,
  };
}

workerScope.onmessage = event => {
  if (event.data.type !== 'analyze') return;
  const { sampleRate, channels: channelBuffers } = event.data;
  const channels = channelBuffers.map(buffer => new Float32Array(buffer));
  const samples = downmixAndResample(channels, sampleRate);
  workerScope.postMessage({ type: 'progress', progress: 0.2 });
  const tempo = estimateBpm(samples);
  const tonal = estimateKey(samples);
  const result: AnalysisResult = {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    key: tonal.key,
    camelot: camelotForKey(tonal.key),
    keyConfidence: tonal.confidence,
    energy: estimateEnergy(samples),
    durationSeconds: samples.length / TARGET_RATE,
    beatGridSeconds: estimateBeatGrid(samples, tempo.bpm),
    waveform: makeWaveform(samples),
  };
  workerScope.postMessage({ type: 'done', result });
};