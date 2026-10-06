import { useEffect, useRef, useState } from 'react';
import { Check, Plug, Radio, RotateCw, X } from 'lucide-react';
import { loadMidiBindings, saveMidiBindings } from '@/lib/local-library';
import {
  emitMidiAction,
  getMidiActions,
  MIDI_ACTION_LABELS,
  MIDI_ACTIONS,
  type MidiAction,
  type MidiBinding,
} from '@/lib/midi-types';

interface MidiInputPort {
  id: string;
  name: string | null;
  manufacturer?: string | null;
  state?: string;
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

interface MidiAccessPort {
  inputs: Map<string, MidiInputPort>;
  onstatechange: ((event: Event) => void) | null;
}

type MidiNavigator = Navigator & {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessPort>;
};

function describeBinding(binding: MidiBinding): string {
  const control = binding.command === 0xb0 ? `CC ${binding.data1}` : `Note ${binding.data1}`;
  return `${control} · Ch ${binding.channel}`;
}

export function MidiControllerPanel() {
  const [bindings, setBindings] = useState<MidiBinding[]>([]);
  const [inputs, setInputs] = useState<MidiInputPort[]>([]);
  const [selectedInputId, setSelectedInputId] = useState('');
  const [learningAction, setLearningAction] = useState<MidiAction | null>(null);
  const [status, setStatus] = useState('Controller not connected');
  const [loading, setLoading] = useState(true);
  const bindingsRef = useRef<MidiBinding[]>([]);
  const learningRef = useRef<MidiAction | null>(null);
  const accessRef = useRef<MidiAccessPort | null>(null);
  const inputRef = useRef<MidiInputPort | null>(null);
  const activeButtonsRef = useRef<Set<MidiAction>>(new Set());

  useEffect(() => {
    let active = true;
    loadMidiBindings()
      .then(saved => {
        if (!active) return;
        bindingsRef.current = saved;
        setBindings(saved);
      })
      .catch(error => {
        if (active) setStatus(error instanceof Error ? error.message : 'Could not load MIDI mappings.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const input = inputs.find(candidate => candidate.id === selectedInputId) ?? null;
    if (inputRef.current) inputRef.current.onmidimessage = null;
    inputRef.current = input;
    activeButtonsRef.current.clear();
    if (!input) {
      if (selectedInputId) {
        setSelectedInputId('');
        setStatus('Controller disconnected');
      }
      return;
    }

    input.onmidimessage = event => {
      const details = getMidiActions(event.data, bindingsRef.current, activeButtonsRef.current);
      details.forEach(emitMidiAction);
      setStatus(`Receiving MIDI from ${input.name || 'controller'}`);
      const learning = learningRef.current;
      if (!learning || event.data.length < 2) return;
      const statusByte = event.data[0];
      const command = statusByte & 0xf0;
      if (command !== 0x80 && command !== 0x90 && command !== 0xb0) return;
      const buttonAction = learning.endsWith('-play') || learning.endsWith('-cue');
      if (!buttonAction && command !== 0xb0) {
        setStatus('Use a MIDI knob or fader for level and mix controls.');
        return;
      }
      const binding: MidiBinding = {
        action: learning,
        channel: (statusByte & 0x0f) + 1,
        command,
        data1: event.data[1] & 0x7f,
      };
      const updated = [...bindingsRef.current.filter(item => item.action !== learning), binding];
      bindingsRef.current = updated;
      setBindings(updated);
      learningRef.current = null;
      setLearningAction(null);
      void saveMidiBindings(updated)
        .then(() => setStatus(`Saved ${MIDI_ACTION_LABELS[learning]} mapping`))
        .catch(error => setStatus(error instanceof Error ? error.message : 'Could not save this MIDI mapping.'));
    };
    return () => {
      input.onmidimessage = null;
      if (inputRef.current === input) inputRef.current = null;
    };
  }, [inputs, selectedInputId]);

  const connect = async () => {
    const requestAccess = (navigator as MidiNavigator).requestMIDIAccess;
    if (!requestAccess) {
      setStatus('Web MIDI is unavailable in this browser. Try the Drop Theory Pro desktop app.');
      return;
    }
    try {
      const access = await requestAccess.call(navigator, { sysex: false });
      accessRef.current = access;
      const refreshInputs = () => {
        const connected: MidiInputPort[] = [];
        access.inputs.forEach(input => {
          if (input.state !== 'disconnected') connected.push(input);
        });
        setInputs(connected);
        setSelectedInputId(current => connected.some(input => input.id === current) ? current : connected[0]?.id ?? '');
        if (connected.length === 0) setStatus('No MIDI input devices found');
      };
      access.onstatechange = refreshInputs;
      refreshInputs();
      if (access.inputs.size > 0) setStatus('MIDI access ready');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'MIDI access was denied or unavailable.');
    }
  };

  const learn = (action: MidiAction) => {
    learningRef.current = action;
    setLearningAction(action);
    setStatus(`Press or move a control for ${MIDI_ACTION_LABELS[action]}`);
  };

  const clearBinding = (action: MidiAction) => {
    const updated = bindingsRef.current.filter(binding => binding.action !== action);
    bindingsRef.current = updated;
    setBindings(updated);
    if (learningRef.current === action) {
      learningRef.current = null;
      setLearningAction(null);
    }
    void saveMidiBindings(updated)
      .then(() => setStatus('MIDI mapping removed and saved'))
      .catch(error => setStatus(error instanceof Error ? error.message : 'Could not remove this MIDI mapping.'));
  };

  return (
    <section className="panel-line rounded-xl p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.16em] text-primary"><Radio size={13} /> Controller</div>
          <h2 className="font-display text-xl font-semibold">MIDI mapping</h2>
          <p className="mt-1 max-w-xl text-[11px] leading-5 text-muted-foreground">Connect a controller, then choose Learn and move a button or knob.</p>
        </div>
        <button onClick={() => void connect()} className="flex w-fit items-center gap-2 rounded-md border border-border px-3 py-2 text-[10px] font-bold hover:border-primary/50">
          {accessRef.current ? <RotateCw size={13} /> : <Plug size={13} />}
          {accessRef.current ? 'Refresh devices' : 'Connect MIDI'}
        </button>
      </div>

      {inputs.length > 0 && (
        <label className="mt-4 block max-w-md">
          <span className="mb-1.5 block font-mono-ui text-[9px] uppercase tracking-[.15em] text-muted-foreground">Input device</span>
          <select value={selectedInputId} onChange={event => setSelectedInputId(event.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-3 text-[11px]">
            {inputs.map(input => <option key={input.id} value={input.id}>{input.name || input.manufacturer || 'MIDI device'}</option>)}
          </select>
        </label>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {MIDI_ACTIONS.map(action => {
          const binding = bindings.find(item => item.action === action);
          const learning = learningAction === action;
          return (
            <div key={action} className="flex min-h-11 items-center gap-2 rounded-lg border border-border/80 bg-card/60 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[10px] font-semibold">{MIDI_ACTION_LABELS[action]}</div>
                <div className="mt-0.5 font-mono-ui text-[9px] text-muted-foreground">{binding ? describeBinding(binding) : 'Not mapped'}</div>
              </div>
              <button
                onClick={() => learn(action)}
                disabled={loading || inputs.length === 0}
                className={`flex shrink-0 items-center gap-1 rounded px-2 py-1.5 text-[9px] font-bold disabled:opacity-40 ${learning ? 'bg-primary text-primary-foreground' : 'border border-border hover:border-primary/50'}`}
              >
                {learning ? <Check size={11} /> : null}{learning ? 'Listening' : 'Learn'}
              </button>
              {binding && (
                <button onClick={() => clearBinding(action)} aria-label={`Clear ${MIDI_ACTION_LABELS[action]} mapping`} className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p role="status" className="mt-3 text-[10px] leading-4 text-muted-foreground">{status}</p>
    </section>
  );
}