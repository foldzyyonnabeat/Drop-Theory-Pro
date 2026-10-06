use std::{
    fs::File,
    io::ErrorKind,
    path::Path,
    sync::{
        mpsc::{self, Receiver, Sender, SyncSender},
        Arc, Mutex,
    },
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use serde::Serialize;
use symphonia::{
    core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymphoniaError,
        formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    },
    default::{get_codecs, get_probe},
};
use tauri::{AppHandle, Manager, State};

const EQ_FREQUENCIES: [f64; 3] = [250.0, 1_000.0, 5_000.0];
const EQ_Q: [f64; 3] = [0.707, 0.8, 0.707];
const STEM_COUNT: usize = 2;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice {
    id: String,
    name: String,
    is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputStatus {
    devices: Vec<AudioOutputDevice>,
    selected_device_id: Option<String>,
    selected_device_name: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatus {
    loaded: bool,
    playing: bool,
    position: f64,
    duration: f64,
    cue_position: f64,
    loop_range: Option<(f64, f64)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioStatus {
    output_name: Option<String>,
    output_error: Option<String>,
    decks: [DeckStatus; 2],
}

struct AudioBuffer {
    samples: Vec<[f32; 2]>,
    sample_rate: u32,
}

impl AudioBuffer {
    fn decode(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|error| {
            format!(
                "Could not read the selected audio file '{}': {error}",
                path.display()
            )
        })?;
        let media = MediaSourceStream::new(Box::new(file), Default::default());
        let probed = get_probe()
            .format(
                &Hint::new(),
                media,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|error| format!("Could not identify this audio format: {error}"))?;
        let mut format = probed.format;
        let track = format
            .default_track()
            .ok_or_else(|| "This audio file does not contain a playable track.".to_string())?;
        let track_id = track.id;
        let sample_rate = track
            .codec_params
            .sample_rate
            .ok_or_else(|| "This audio file does not report a sample rate.".to_string())?;
        let mut decoder = get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|error| format!("This audio codec is not supported: {error}"))?;
        let mut samples = Vec::new();

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                    break;
                }
                Err(SymphoniaError::ResetRequired) => {
                    return Err(
                        "This file requires an unsupported audio decoder reset.".to_string()
                    );
                }
                Err(error) => return Err(format!("Could not read audio data: {error}")),
            };
            if packet.track_id() != track_id {
                continue;
            }

            let decoded = decoder
                .decode(&packet)
                .map_err(|error| format!("Could not decode audio data: {error}"))?;
            let channels = decoded.spec().channels.count();
            if channels == 0 {
                return Err("This audio file has no output channels.".to_string());
            }
            let mut converted =
                SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            converted.copy_interleaved_ref(decoded);
            for frame in converted.samples().chunks(channels) {
                let left = frame[0];
                let right = frame.get(1).copied().unwrap_or(left);
                samples.push([left, right]);
            }
        }

        if samples.is_empty() {
            return Err("This audio file contains no decodable samples.".to_string());
        }
        Ok(Self {
            samples,
            sample_rate,
        })
    }

    fn sample_at(&self, seconds: f64) -> [f32; 2] {
        let sample_position =
            (seconds.max(0.0) * f64::from(self.sample_rate)).min((self.samples.len() - 1) as f64);
        let first = sample_position.floor() as usize;
        let second = (first + 1).min(self.samples.len() - 1);
        let fraction = (sample_position - first as f64) as f32;
        [
            self.samples[first][0] * (1.0 - fraction) + self.samples[second][0] * fraction,
            self.samples[first][1] * (1.0 - fraction) + self.samples[second][1] * fraction,
        ]
    }

    fn duration(&self) -> f64 {
        self.samples.len() as f64 / f64::from(self.sample_rate)
    }
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn peaking(sample_rate: f64, frequency: f64, q: f64, decibels: f64) -> Self {
        let a = 10.0_f64.powf(decibels / 40.0);
        let omega = 2.0 * std::f64::consts::PI * frequency / sample_rate;
        let alpha = omega.sin() / (2.0 * q);
        let cos = omega.cos();
        let a0 = 1.0 + alpha / a;
        Self {
            b0: ((1.0 + alpha * a) / a0) as f32,
            b1: ((-2.0 * cos) / a0) as f32,
            b2: ((1.0 - alpha * a) / a0) as f32,
            a1: ((-2.0 * cos) / a0) as f32,
            a2: ((1.0 - alpha / a) / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let output = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * output + self.z2;
        self.z2 = self.b2 * input - self.a2 * output;
        output
    }
}

struct Deck {
    buffer: Option<AudioBuffer>,
    stems: Option<[AudioBuffer; STEM_COUNT]>,
    stems_enabled: bool,
    stem_gains: [f32; STEM_COUNT],
    position: f64,
    playing: bool,
    cue_position: f64,
    loop_range: Option<(f64, f64)>,
    tempo: f64,
    gain: f32,
    equalizer: [f64; 3],
    filters: [[Biquad; 2]; 3],
}

impl Deck {
    fn new(sample_rate: f64) -> Self {
        Self {
            buffer: None,
            stems: None,
            stems_enabled: false,
            stem_gains: [1.0; STEM_COUNT],
            position: 0.0,
            playing: false,
            cue_position: 0.0,
            loop_range: None,
            tempo: 1.0,
            gain: 1.0,
            equalizer: [0.0; 3],
            filters: std::array::from_fn(|band| {
                std::array::from_fn(|_| {
                    Biquad::peaking(sample_rate, EQ_FREQUENCIES[band], EQ_Q[band], 0.0)
                })
            }),
        }
    }

    fn status(&self) -> DeckStatus {
        DeckStatus {
            loaded: self.buffer.is_some(),
            playing: self.playing,
            position: self.position,
            duration: self.buffer.as_ref().map_or(0.0, AudioBuffer::duration),
            cue_position: self.cue_position,
            loop_range: self.loop_range,
        }
    }

    fn set_eq(&mut self, band: usize, decibels: f64, sample_rate: f64) {
        self.equalizer[band] = decibels;
        for channel in &mut self.filters[band] {
            *channel = Biquad::peaking(sample_rate, EQ_FREQUENCIES[band], EQ_Q[band], decibels);
        }
    }

    fn render(&mut self, output_rate: f64) -> [f32; 2] {
        if !self.playing {
            return [0.0, 0.0];
        }
        let Some(buffer) = self.buffer.as_ref() else {
            self.playing = false;
            return [0.0, 0.0];
        };
        let duration = buffer.duration();
        if let Some((start, end)) = self.loop_range {
            if self.position >= end {
                self.position = start + (self.position - start) % (end - start);
            }
        } else if self.position >= duration {
            self.position = duration;
            self.playing = false;
            return [0.0, 0.0];
        }

        let mut sample = if self.stems_enabled {
            if let Some(stems) = self.stems.as_ref() {
                let mut mix = [0.0, 0.0];
                for (index, stem) in stems.iter().enumerate() {
                    let stem_sample = stem.sample_at(self.position);
                    mix[0] += stem_sample[0] * self.stem_gains[index];
                    mix[1] += stem_sample[1] * self.stem_gains[index];
                }
                mix
            } else {
                buffer.sample_at(self.position)
            }
        } else {
            buffer.sample_at(self.position)
        };
        for band in 0..3 {
            sample[0] = self.filters[band][0].process(sample[0]);
            sample[1] = self.filters[band][1].process(sample[1]);
        }
        self.position += self.tempo / output_rate;
        [sample[0] * self.gain, sample[1] * self.gain]
    }
}

struct MixerState {
    decks: [Deck; 2],
    sample_rate: f64,
    crossfader: f32,
    master_gain: f32,
    output_error: Option<String>,
    selected_device_id: Option<String>,
    selected_device_name: Option<String>,
    pending_load_ids: [Option<String>; 2],
    loaded_track_ids: [Option<String>; 2],
}

impl MixerState {
    fn new(sample_rate: f64) -> Self {
        Self {
            decks: [Deck::new(sample_rate), Deck::new(sample_rate)],
            sample_rate,
            crossfader: 0.5,
            master_gain: 0.82,
            output_error: None,
            selected_device_id: None,
            selected_device_name: None,
            pending_load_ids: [None, None],
            loaded_track_ids: [None, None],
        }
    }

    fn render(&mut self, output_rate: f64) -> [f32; 2] {
        let angle = f64::from(self.crossfader.clamp(0.0, 1.0)) * std::f64::consts::FRAC_PI_2;
        let gain_a = angle.cos() as f32;
        let gain_b = angle.sin() as f32;
        let a = self.decks[0].render(output_rate);
        let b = self.decks[1].render(output_rate);
        [
            soft_limit((a[0] * gain_a + b[0] * gain_b) * self.master_gain),
            soft_limit((a[1] * gain_a + b[1] * gain_b) * self.master_gain),
        ]
    }

    fn statuses(&self) -> [DeckStatus; 2] {
        [self.decks[0].status(), self.decks[1].status()]
    }
}

fn soft_limit(sample: f32) -> f32 {
    let magnitude = sample.abs();
    if magnitude <= 0.9 {
        sample
    } else {
        sample.signum() * (0.9 + 0.1 * (1.0 - (-(magnitude - 0.9) * 10.0).exp()))
    }
}

/// A stream error is terminal for the CPAL stream.  The stream must be
/// dropped by the worker that owns it before another stream can be created.
/// Keeping this decision separate makes it possible to test the recovery
/// policy without constructing platform audio devices.
fn stream_requires_recovery(output_error: Option<&str>, selected_available: bool) -> bool {
    output_error.is_some() || !selected_available
}

enum AudioCommand {
    EnsureOutput(SyncSender<Result<(), String>>),
    SelectOutput {
        index: usize,
        reply: SyncSender<Result<(), String>>,
    },
}

pub struct NativeAudioEngine {
    mixer: Arc<Mutex<MixerState>>,
    commands: Mutex<Sender<AudioCommand>>,
}

impl Default for NativeAudioEngine {
    fn default() -> Self {
        // Tests and non-Tauri callers use an unpersisted worker.
        Self::start(None)
    }
}

impl NativeAudioEngine {
    pub fn new(app: AppHandle) -> Self {
        Self::start(Some(app))
    }

    fn start(app: Option<AppHandle>) -> Self {
        let mixer = Arc::new(Mutex::new(MixerState::new(48_000.0)));
        if let Some(app) = app.as_ref() {
            match super::load_audio_output_preference(app) {
                Ok(Some((id, name))) => {
                    if let Ok(mut state) = mixer.lock() {
                        state.selected_device_id = Some(id);
                        state.selected_device_name = Some(name);
                    }
                }
                Err(error) => {
                    if let Ok(mut state) = mixer.lock() {
                        state.output_error = Some(format!(
                            "Could not restore the saved audio output: {error} Choose an output explicitly."
                        ));
                    }
                }
                Ok(None) => {}
            }
        }
        let (sender, receiver) = mpsc::channel();
        let worker_mixer = Arc::clone(&mixer);
        std::thread::spawn(move || audio_output_worker(receiver, worker_mixer, app));
        Self {
            mixer,
            commands: Mutex::new(sender),
        }
    }

    fn outputs(&self) -> Result<AudioOutputStatus, String> {
        let host = cpal::default_host();
        let default_name = host
            .default_output_device()
            .and_then(|device| device.name().ok());
        let devices = host
            .output_devices()
            .map_err(|error| format!("Could not list audio output devices: {error}"))?
            .enumerate()
            .map(|(index, device)| {
                let name = device
                    .name()
                    .unwrap_or_else(|_| format!("Audio output {}", index + 1));
                AudioOutputDevice {
                    id: format!("device:{index}"),
                    is_default: default_name.as_deref() == Some(name.as_str()),
                    name,
                }
            })
            .collect::<Vec<_>>();
        let default_id = devices
            .iter()
            .find(|device| device.is_default)
            .map(|device| device.id.clone());
        let mixer = self
            .mixer
            .lock()
            .map_err(|_| "The native audio mixer is unavailable.".to_string())?;
        let selected_device_id = mixer.selected_device_id.clone().or(default_id);
        let selected_device_name = mixer.selected_device_name.clone().or_else(|| {
            selected_device_id.as_ref().and_then(|id| {
                devices
                    .iter()
                    .find(|device| &device.id == id)
                    .map(|device| device.name.clone())
            })
        });
        Ok(AudioOutputStatus {
            devices,
            selected_device_id,
            selected_device_name,
            error: mixer.output_error.clone(),
        })
    }

    fn select_output(&self, device_id: &str) -> Result<AudioOutputStatus, String> {
        let index = device_id
            .strip_prefix("device:")
            .ok_or_else(|| "Choose an available audio output device.".to_string())?
            .parse::<usize>()
            .map_err(|_| "The selected audio output device is invalid.".to_string())?;
        let (reply, response) = mpsc::sync_channel(1);
        self.send_command(AudioCommand::SelectOutput { index, reply })?;
        response
            .recv()
            .map_err(|error| format!("The audio output worker stopped unexpectedly: {error}"))??;
        self.outputs()
    }

    fn ensure_output(&self) -> Result<(), String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.send_command(AudioCommand::EnsureOutput(reply))?;
        response
            .recv()
            .map_err(|error| format!("The audio output worker stopped unexpectedly: {error}"))?
    }

    fn send_command(&self, command: AudioCommand) -> Result<(), String> {
        self.commands
            .lock()
            .map_err(|_| "The native audio output worker is unavailable.".to_string())?
            .send(command)
            .map_err(|error| format!("The native audio output worker stopped: {error}"))
    }

    fn begin_load(&self, deck: usize, request_id: String) -> Result<(), String> {
        let mut mixer = self
            .mixer
            .lock()
            .map_err(|_| "The native audio mixer is unavailable.".to_string())?;
        mixer.pending_load_ids[deck] = Some(request_id);
        Ok(())
    }

    fn load_buffer(
        &self,
        deck: usize,
        request_id: &str,
        buffer: AudioBuffer,
    ) -> Result<DeckStatus, String> {
        self.ensure_output()?;
        let mut mixer = self
            .mixer
            .lock()
            .map_err(|_| "The native audio mixer is unavailable.".to_string())?;
        if mixer.pending_load_ids[deck].as_deref() != Some(request_id) {
            return Err("A newer track load replaced this one.".to_string());
        }
        let sample_rate = mixer.sample_rate;
        let target = &mut mixer.decks[deck];
        target.buffer = Some(buffer);
        target.stems = None;
        target.stems_enabled = false;
        target.position = 0.0;
        target.playing = false;
        target.cue_position = 0.0;
        target.loop_range = None;
        target.tempo = 1.0;
        let equalizer = target.equalizer;
        target.set_eq(0, equalizer[0], sample_rate);
        target.set_eq(1, equalizer[1], sample_rate);
        target.set_eq(2, equalizer[2], sample_rate);
        let status = target.status();
        mixer.pending_load_ids[deck] = None;
        mixer.loaded_track_ids[deck] = Some(request_id.to_string());
        Ok(status)
    }

    fn load_stems(
        &self,
        deck: usize,
        request_id: &str,
        buffers: [AudioBuffer; STEM_COUNT],
    ) -> Result<(), String> {
        let mut mixer = self
            .mixer
            .lock()
            .map_err(|_| "The native audio mixer is unavailable.".to_string())?;
        if mixer.loaded_track_ids[deck].as_deref() != Some(request_id) {
            return Err("The deck changed while these stems were loading. Separate the current track again.".to_string());
        }
        let target = &mut mixer.decks[deck];
        if target.buffer.is_none() {
            return Err("Load a track on this deck before loading separated stems.".to_string());
        }
        target.stems = Some(buffers);
        target.stems_enabled = false;
        target.stem_gains = [1.0; STEM_COUNT];
        Ok(())
    }

    fn unload(&self, deck: usize) -> Result<(), String> {
        let mut mixer = self
            .mixer
            .lock()
            .map_err(|_| "The native audio mixer is unavailable.".to_string())?;
        mixer.pending_load_ids[deck] = None;
        mixer.loaded_track_ids[deck] = None;
        let sample_rate = mixer.sample_rate;
        mixer.decks[deck] = Deck::new(sample_rate);
        Ok(())
    }

    fn status(&self) -> Result<NativeAudioStatus, String> {
        let mixer = self
            .mixer
            .lock()
            .map_err(|_| "The native audio mixer is unavailable.".to_string())?;
        Ok(NativeAudioStatus {
            output_name: mixer.selected_device_name.clone(),
            output_error: mixer.output_error.clone(),
            decks: mixer.statuses(),
        })
    }

    fn update_mixer(
        &self,
        update: impl FnOnce(&mut MixerState) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut mixer = self
            .mixer
            .lock()
            .map_err(|_| "The native audio mixer is unavailable.".to_string())?;
        update(&mut mixer)
    }
}

fn audio_output_worker(
    commands: Receiver<AudioCommand>,
    mixer: Arc<Mutex<MixerState>>,
    app: Option<AppHandle>,
) {
    let mut stream: Option<Stream> = None;
    while let Ok(command) = commands.recv() {
        match command {
            AudioCommand::EnsureOutput(reply) => {
                let selected_available = selected_output_is_available(&mixer);
                let error = mixer
                    .lock()
                    .ok()
                    .and_then(|state| state.output_error.clone());
                let result = if stream_requires_recovery(error.as_deref(), selected_available) {
                    // Do not retry automatically.  This command is also
                    // allowed to observe the failure, so callers get a
                    // stable recoverable error until they explicitly choose
                    // an output again.
                    stream.take();
                    if error.is_none() && !selected_available {
                        if let Ok(mut state) = mixer.lock() {
                            state.output_error = Some(
                                "The selected audio output is no longer available. Choose an output to resume playback."
                                    .to_string(),
                            );
                        }
                    }
                    Err(error.unwrap_or_else(|| {
                        "The selected audio output is no longer available. Choose an output to resume playback.".to_string()
                    }))
                } else if stream.is_some() {
                    Ok(())
                } else {
                    let result = start_selected_or_default_output(&mut stream, &mixer);
                    if let Err(error) = &result {
                        if let Ok(mut state) = mixer.lock() {
                            state.output_error = Some(error.clone());
                        }
                    }
                    result
                };
                let _ = reply.send(result);
            }
            AudioCommand::SelectOutput { index, reply } => {
                // Selection is the explicit recovery action.  Always drop a
                // failed/stale stream on this worker before touching CPAL.
                stream.take();
                let result = select_output_on_worker(index, &mut stream, &mixer, app.as_ref());
                let _ = reply.send(result);
            }
        }
    }
}

fn selected_output_is_available(mixer: &Arc<Mutex<MixerState>>) -> bool {
    let selected_id = mixer
        .lock()
        .ok()
        .and_then(|state| state.selected_device_id.clone());
    let Some(selected_id) = selected_id else {
        return true;
    };
    let Some(index) = selected_id
        .strip_prefix("device:")
        .and_then(|value| value.parse::<usize>().ok())
    else {
        return false;
    };
    cpal::default_host()
        .output_devices()
        .ok()
        .and_then(|mut devices| devices.nth(index))
        .is_some()
}

fn start_selected_or_default_output(
    stream: &mut Option<Stream>,
    mixer: &Arc<Mutex<MixerState>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let selected_id = mixer
        .lock()
        .ok()
        .and_then(|state| state.selected_device_id.clone());
    let selected_device = if let Some(id) = selected_id {
        let index = id
            .strip_prefix("device:")
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| "The selected audio output device is invalid.".to_string())?;
        host.output_devices()
            .map_err(|error| format!("Could not list audio output devices: {error}"))?
            .nth(index)
            .ok_or_else(|| "The selected audio output device is no longer available.".to_string())?
    } else {
        host.default_output_device().ok_or_else(|| {
            "No audio output device is available. Connect an output device and refresh the list."
                .to_string()
        })?
    };
    let name = selected_device
        .name()
        .map_err(|error| format!("Could not read the audio output device name: {error}"))?;
    if let Some(expected_name) = mixer
        .lock()
        .ok()
        .and_then(|state| state.selected_device_name.clone())
    {
        if expected_name != name {
            return Err(format!(
                "The saved audio output '{}' is not available at its saved identity. Choose an output explicitly.",
                expected_name
            ));
        }
    }
    let selected_id = host.output_devices().ok().and_then(|devices| {
        devices.enumerate().find_map(|(index, device)| {
            (device.name().ok().as_deref() == Some(name.as_str()))
                .then(|| format!("device:{index}"))
        })
    });
    let new_stream = create_output_stream(&selected_device, Arc::clone(mixer))?;
    new_stream
        .play()
        .map_err(|error| format!("Could not start audio output on '{name}': {error}"))?;
    *stream = Some(new_stream);
    if let Ok(mut state) = mixer.lock() {
        state.selected_device_id = selected_id;
        state.selected_device_name = Some(name);
        state.output_error = None;
    }
    Ok(())
}

fn select_output_on_worker(
    index: usize,
    stream: &mut Option<Stream>,
    mixer: &Arc<Mutex<MixerState>>,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    if let Ok(mut state) = mixer.lock() {
        state.output_error = None;
    }
    let result = select_output_on_worker_inner(index, stream, mixer);
    if let Err(error) = &result {
        if let Ok(mut state) = mixer.lock() {
            state.output_error = Some(error.clone());
        }
    }
    if result.is_ok() {
        if let (Some(app), Ok(state)) = (app, mixer.lock()) {
            if let (Some(id), Some(name)) = (
                state.selected_device_id.as_deref(),
                state.selected_device_name.as_deref(),
            ) {
                let _ = super::save_audio_output_preference(app, id, name);
            }
        }
    }
    result
}

fn select_output_on_worker_inner(
    index: usize,
    stream: &mut Option<Stream>,
    mixer: &Arc<Mutex<MixerState>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .output_devices()
        .map_err(|error| format!("Could not list audio output devices: {error}"))?
        .nth(index)
        .ok_or_else(|| "The selected audio output device is no longer available.".to_string())?;
    let name = device
        .name()
        .map_err(|error| format!("Could not read the audio output device name: {error}"))?;
    let new_stream = create_output_stream(&device, Arc::clone(mixer))?;
    new_stream
        .play()
        .map_err(|error| format!("Could not start audio output on '{name}': {error}"))?;
    *stream = Some(new_stream);
    if let Ok(mut state) = mixer.lock() {
        state.selected_device_id = Some(format!("device:{index}"));
        state.selected_device_name = Some(name);
        state.output_error = None;
    }
    Ok(())
}

fn create_output_stream(device: &Device, mixer: Arc<Mutex<MixerState>>) -> Result<Stream, String> {
    let supported = device
        .default_output_config()
        .map_err(|error| format!("Could not configure audio output: {error}"))?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let channels = usize::from(config.channels);
    if channels == 0 {
        return Err("The selected audio output has no channels.".to_string());
    }
    if let Ok(mut state) = mixer.lock() {
        let sample_rate = f64::from(config.sample_rate.0);
        state.sample_rate = sample_rate;
        for deck in &mut state.decks {
            for band in 0..3 {
                deck.set_eq(band, deck.equalizer[band], sample_rate);
            }
        }
    }
    let sample_rate = f64::from(config.sample_rate.0);

    let stream = match sample_format {
        SampleFormat::F32 => {
            let callback_mixer = Arc::clone(&mixer);
            device.build_output_stream(
                &config,
                move |data: &mut [f32], _| render_f32(data, channels, sample_rate, &callback_mixer),
                stream_error_handler(&mixer),
                None,
            )
        }
        SampleFormat::I16 => {
            let callback_mixer = Arc::clone(&mixer);
            device.build_output_stream(
                &config,
                move |data: &mut [i16], _| render_i16(data, channels, sample_rate, &callback_mixer),
                stream_error_handler(&mixer),
                None,
            )
        }
        SampleFormat::U16 => {
            let callback_mixer = Arc::clone(&mixer);
            device.build_output_stream(
                &config,
                move |data: &mut [u16], _| render_u16(data, channels, sample_rate, &callback_mixer),
                stream_error_handler(&mixer),
                None,
            )
        }
        format => {
            return Err(format!(
                "Audio output sample format '{format:?}' is not supported."
            ))
        }
    };
    stream.map_err(|error| format!("Could not open audio output: {error}"))
}

fn stream_error_handler(
    mixer: &Arc<Mutex<MixerState>>,
) -> impl FnMut(cpal::StreamError) + Send + 'static {
    let state = Arc::clone(mixer);
    move |error| {
        if let Ok(mut state) = state.lock() {
            for deck in &mut state.decks {
                deck.playing = false;
            }
            state.output_error = Some(format!("Audio output stopped unexpectedly: {error}"));
        }
    }
}

fn render_f32(data: &mut [f32], channels: usize, output_rate: f64, mixer: &Arc<Mutex<MixerState>>) {
    render_frames(data, channels, mixer, |sample| sample, output_rate);
}

fn render_i16(data: &mut [i16], channels: usize, output_rate: f64, mixer: &Arc<Mutex<MixerState>>) {
    render_frames(
        data,
        channels,
        mixer,
        |sample| (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16,
        output_rate,
    );
}

fn render_u16(data: &mut [u16], channels: usize, output_rate: f64, mixer: &Arc<Mutex<MixerState>>) {
    render_frames(
        data,
        channels,
        mixer,
        |sample| (((sample.clamp(-1.0, 1.0) * 0.5) + 0.5) * f32::from(u16::MAX)) as u16,
        output_rate,
    );
}

fn render_frames<T>(
    data: &mut [T],
    channels: usize,
    mixer: &Arc<Mutex<MixerState>>,
    convert: impl Fn(f32) -> T,
    output_rate: f64,
) {
    let Ok(mut state) = mixer.lock() else {
        for output in data {
            *output = convert(0.0);
        }
        return;
    };
    for frame in data.chunks_mut(channels) {
        let [left, right] = state.render(output_rate);
        for (channel, output) in frame.iter_mut().enumerate() {
            let sample = if channels == 1 {
                (left + right) * 0.5
            } else if channel == 0 || channel % 2 == 0 {
                left
            } else {
                right
            };
            *output = convert(sample);
        }
    }
}

fn deck_index(deck: &str) -> Result<usize, String> {
    match deck {
        "a" => Ok(0),
        "b" => Ok(1),
        _ => Err("Choose deck A or deck B.".to_string()),
    }
}

fn bounded(value: f64, minimum: f64, maximum: f64, label: &str) -> Result<f64, String> {
    if !value.is_finite() {
        return Err(format!("The {label} value must be a finite number."));
    }
    Ok(value.clamp(minimum, maximum))
}

#[tauri::command]
pub fn get_native_audio_outputs(
    audio: State<'_, NativeAudioEngine>,
) -> Result<AudioOutputStatus, String> {
    audio.outputs()
}

#[tauri::command]
pub fn set_native_audio_output(
    audio: State<'_, NativeAudioEngine>,
    device_id: String,
) -> Result<AudioOutputStatus, String> {
    audio.select_output(&device_id)
}

#[tauri::command]
pub fn get_native_audio_status(
    audio: State<'_, NativeAudioEngine>,
) -> Result<NativeAudioStatus, String> {
    audio.status()
}

#[tauri::command]
pub fn load_native_deck(
    app: AppHandle,
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    path: String,
    request_id: String,
) -> Result<DeckStatus, String> {
    let deck = deck_index(&deck)?;
    if request_id.trim().is_empty() || request_id.len() > 128 {
        return Err("Invalid native deck load identifier.".to_string());
    }
    audio.begin_load(deck, request_id.clone())?;
    let authorized_path = super::authorize_track_file(app, path)?;
    let buffer = AudioBuffer::decode(Path::new(&authorized_path))?;
    audio.load_buffer(deck, &request_id, buffer)
}

#[tauri::command]
pub fn load_native_stems(
    app: AppHandle,
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    paths: Vec<String>,
    request_id: String,
) -> Result<(), String> {
    let deck = deck_index(&deck)?;
    if paths.len() != STEM_COUNT {
        return Err("Exactly two UVR audio stems are required.".to_string());
    }
    let cache_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?
        .join("stems");
    let cache_root = std::fs::canonicalize(&cache_root)
        .map_err(|error| format!("The local stem cache is unavailable: {error}"))?;
    let mut buffers = Vec::with_capacity(STEM_COUNT);
    for path in paths {
        let path = std::fs::canonicalize(&path)
            .map_err(|error| format!("Could not open a separated stem: {error}"))?;
        if !path.is_file() || !path.starts_with(&cache_root) {
            return Err(
                "Separated audio can only be loaded from Drop Theory Pro's local stem cache."
                    .to_string(),
            );
        }
        buffers.push(AudioBuffer::decode(&path)?);
    }
    let buffers: [AudioBuffer; STEM_COUNT] = buffers
        .try_into()
        .map_err(|_| "Could not load the two UVR audio stems.".to_string())?;
    audio.load_stems(deck, &request_id, buffers)
}

#[tauri::command]
pub fn unload_native_deck(audio: State<'_, NativeAudioEngine>, deck: String) -> Result<(), String> {
    audio.unload(deck_index(&deck)?)
}

#[tauri::command]
pub fn play_native_deck(audio: State<'_, NativeAudioEngine>, deck: String) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        if mixer.decks[index].buffer.is_none() {
            return Err(format!(
                "Load an audio file on deck {} before playing.",
                deck.to_uppercase()
            ));
        }
        if mixer.decks[index].position >= mixer.decks[index].status().duration {
            mixer.decks[index].position = mixer.decks[index].cue_position;
        }
        mixer.decks[index].playing = true;
        Ok(())
    })
}

#[tauri::command]
pub fn pause_native_deck(audio: State<'_, NativeAudioEngine>, deck: String) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        mixer.decks[index].playing = false;
        Ok(())
    })
}

#[tauri::command]
pub fn seek_native_deck(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    position: f64,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        let duration = mixer.decks[index].status().duration;
        mixer.decks[index].position = bounded(position, 0.0, duration, "seek position")?;
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_cue(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    position: f64,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        let duration = mixer.decks[index].status().duration;
        mixer.decks[index].cue_position = bounded(position, 0.0, duration, "cue position")?;
        Ok(())
    })
}

#[tauri::command]
pub fn return_native_to_cue(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        let target = &mut mixer.decks[index];
        target.playing = false;
        target.position = target.cue_position;
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_loop(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        let duration = mixer.decks[index].status().duration;
        mixer.decks[index].loop_range = match (start, end) {
            (Some(start), Some(end)) => {
                let start = bounded(start, 0.0, duration, "loop start")?;
                let end = bounded(end, 0.0, duration, "loop end")?;
                if end <= start {
                    return Err("The loop end must be after its start.".to_string());
                }
                Some((start, end))
            }
            (None, None) => None,
            _ => return Err("A loop needs both a start and an end position.".to_string()),
        };
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_tempo(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    rate: f64,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        mixer.decks[index].tempo = bounded(rate, 0.5, 1.5, "tempo")?;
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_deck_gain(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    gain: f64,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        mixer.decks[index].gain = bounded(gain, 0.0, 1.0, "deck level")? as f32;
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_deck_eq(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    band: String,
    decibels: f64,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    let band = match band.as_str() {
        "low" => 0,
        "mid" => 1,
        "high" => 2,
        _ => return Err("Choose a low, mid, or high EQ band.".to_string()),
    };
    audio.update_mixer(|mixer| {
        let sample_rate = mixer.sample_rate;
        let value = bounded(decibels, -12.0, 12.0, "EQ")?;
        mixer.decks[index].set_eq(band, value, sample_rate);
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_crossfader(
    audio: State<'_, NativeAudioEngine>,
    position: f64,
) -> Result<(), String> {
    audio.update_mixer(|mixer| {
        mixer.crossfader = bounded(position, 0.0, 1.0, "crossfader")? as f32;
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_master_gain(
    audio: State<'_, NativeAudioEngine>,
    gain: f64,
) -> Result<(), String> {
    audio.update_mixer(|mixer| {
        mixer.master_gain = bounded(gain, 0.0, 1.0, "master output")? as f32;
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_stems_enabled(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    enabled: bool,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    audio.update_mixer(|mixer| {
        let target = &mut mixer.decks[index];
        if enabled && target.stems.is_none() {
            return Err("Load both UVR stems before enabling stem playback.".to_string());
        }
        target.stems_enabled = enabled;
        Ok(())
    })
}

#[tauri::command]
pub fn set_native_stem_gain(
    audio: State<'_, NativeAudioEngine>,
    deck: String,
    stem: String,
    gain: f64,
) -> Result<(), String> {
    let index = deck_index(&deck)?;
    let stem = match stem.as_str() {
        "vocals" => 0,
        "instrumental" => 1,
        _ => return Err("Choose vocals or instrumental.".to_string()),
    };
    audio.update_mixer(|mixer| {
        mixer.decks[index].stem_gains[stem] = bounded(gain, 0.0, 1.0, "stem level")? as f32;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{soft_limit, stream_requires_recovery, AudioBuffer, Deck, MixerState};

    #[test]
    fn stream_recovery_policy_only_requires_explicit_reselection_after_failure() {
        assert!(stream_requires_recovery(Some("device disappeared"), true));
        assert!(stream_requires_recovery(None, false));
        assert!(!stream_requires_recovery(None, true));
    }

    #[test]
    fn two_decks_mix_with_equal_power_crossfader_and_limit_peaks() {
        let make_buffer = || AudioBuffer {
            samples: vec![[1.0, 1.0]; 4],
            sample_rate: 48_000,
        };
        let mut mixer = MixerState::new(48_000.0);
        mixer.decks[0].buffer = Some(make_buffer());
        mixer.decks[1].buffer = Some(make_buffer());
        mixer.decks[0].playing = true;
        mixer.decks[1].playing = true;
        mixer.master_gain = 1.0;
        let output = mixer.render(48_000.0);
        assert!(output[0].is_finite() && output[0] <= 1.0);
        assert!(output[1].is_finite() && output[1] <= 1.0);
        assert!(output[0] > 0.9);
    }

    #[test]
    fn tempo_and_loop_keep_playhead_inside_the_requested_range() {
        let mut deck = Deck::new(48_000.0);
        deck.buffer = Some(AudioBuffer {
            samples: vec![[0.1, 0.1]; 48_000],
            sample_rate: 48_000,
        });
        deck.loop_range = Some((0.1, 0.2));
        deck.position = 0.2;
        deck.tempo = 1.0;
        deck.playing = true;
        deck.render(48_000.0);
        assert!(deck.position >= 0.1 && deck.position < 0.2);
    }

    #[test]
    fn soft_limiter_preserves_quiet_audio_and_bounds_overload() {
        assert_eq!(soft_limit(0.5), 0.5);
        assert!(soft_limit(4.0) <= 1.0);
        assert!(soft_limit(-4.0) >= -1.0);
    }
}
