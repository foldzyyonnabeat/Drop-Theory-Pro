export const MIDI_ACTIONS = [
  'deck-a-play',
  'deck-a-cue',
  'deck-a-gain',
  'deck-b-play',
  'deck-b-cue',
  'deck-b-gain',
  'crossfader',
  'master',
] as const;

export type MidiAction = (typeof MIDI_ACTIONS)[number];

export interface MidiBinding {
  action: MidiAction;
  channel: number;
  command: number;
  data1: number;
}

export interface MidiActionDetail {
  action: MidiAction;
  value: number;
}

export const MIDI_ACTION_LABELS: Record<MidiAction, string> = {
  'deck-a-play': 'Deck A · Play and pause',
  'deck-a-cue': 'Deck A · Cue and return',
  'deck-a-gain': 'Deck A · Level',
  'deck-b-play': 'Deck B · Play and pause',
  'deck-b-cue': 'Deck B · Cue and return',
  'deck-b-gain': 'Deck B · Level',
  crossfader: 'Crossfader',
  master: 'Master output',
};

export const MIDI_ACTION_EVENT = 'crateforge:midi-action';

const buttonActions = new Set<MidiAction>([
  'deck-a-play',
  'deck-a-cue',
  'deck-b-play',
  'deck-b-cue',
]);

function isRelease(command: number, value: number): boolean {
  return command === 0x80 || (command === 0x90 && value === 0);
}

export function getMidiActions(
  data: Uint8Array,
  bindings: MidiBinding[],
  activeButtons: Set<MidiAction>,
): MidiActionDetail[] {
  if (data.length < 2) return [];
  const status = data[0];
  const command = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const data1 = data[1] & 0x7f;
  const value = (data[2] ?? 0) & 0x7f;
  const noteCommand = command === 0x80 || command === 0x90;
  const release = isRelease(command, value);
  const actions: MidiActionDetail[] = [];

  for (const binding of bindings) {
    const isNoteBinding = binding.command === 0x90 || binding.command === 0x80;
    const commandMatches = isNoteBinding ? noteCommand : binding.command === command;
    if (!commandMatches || binding.channel !== channel || binding.data1 !== data1) continue;

    if (buttonActions.has(binding.action)) {
      const pressed = isNoteBinding ? !release : value >= 64;
      const wasPressed = activeButtons.has(binding.action);
      if (pressed && !wasPressed) actions.push({ action: binding.action, value: 1 });
      if (pressed) activeButtons.add(binding.action);
      else activeButtons.delete(binding.action);
      continue;
    }

    if (command === 0xb0) {
      actions.push({ action: binding.action, value: value / 127 });
    }
  }

  return actions;
}

export function emitMidiAction(detail: MidiActionDetail): void {
  window.dispatchEvent(new CustomEvent<MidiActionDetail>(MIDI_ACTION_EVENT, { detail }));
}