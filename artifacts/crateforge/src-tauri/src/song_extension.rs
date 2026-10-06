use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use symphonia::{
    core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymphoniaError,
        formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    },
    default::{get_codecs, get_probe},
};
use tauri::{AppHandle, Manager};

const WAV_HEADER_BYTES: u64 = 44;
const WAV_MAX_DATA_BYTES: u64 = u32::MAX as u64 - 36;
const MIX_CHUNK_FRAMES: usize = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentalStemPaths {
    drums: String,
    bass: String,
    other: String,
}

struct Pcm16Wave {
    file: BufReader<File>,
    data_offset: u64,
    channels: u16,
    sample_rate: u32,
    frame_count: u64,
}

impl Pcm16Wave {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path)
            .map_err(|error| format!("Could not open a separated instrument stem: {error}"))?;
        let mut file = BufReader::new(file);
        let mut header = [0_u8; 12];
        file.read_exact(&mut header)
            .map_err(|error| format!("A separated stem is not a valid WAV file: {error}"))?;
        if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
            return Err("A separated stem is not a supported PCM WAV file.".to_string());
        }

        let mut format: Option<(u16, u32, u16)> = None;
        let mut data: Option<(u64, u64)> = None;
        loop {
            let mut chunk = [0_u8; 8];
            match file.read_exact(&mut chunk) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(format!("Could not read a separated stem: {error}")),
            }
            let chunk_size =
                u64::from(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
            let chunk_start = file
                .stream_position()
                .map_err(|error| format!("Could not seek in a separated stem: {error}"))?;
            match &chunk[0..4] {
                b"fmt " => {
                    if chunk_size < 16 {
                        return Err(
                            "A separated stem has an incomplete WAV format header.".to_string()
                        );
                    }
                    let mut fmt = [0_u8; 16];
                    file.read_exact(&mut fmt).map_err(|error| {
                        format!("Could not read a separated stem format: {error}")
                    })?;
                    let encoding = u16::from_le_bytes([fmt[0], fmt[1]]);
                    let channels = u16::from_le_bytes([fmt[2], fmt[3]]);
                    let sample_rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
                    let bits_per_sample = u16::from_le_bytes([fmt[14], fmt[15]]);
                    if encoding != 1 || bits_per_sample != 16 || !(channels == 1 || channels == 2) {
                        return Err(
                            "Separated stems must be mono or stereo 16-bit PCM WAV files."
                                .to_string(),
                        );
                    }
                    format = Some((channels, sample_rate, bits_per_sample));
                }
                b"data" => data = Some((chunk_start, chunk_size)),
                _ => {}
            }
            let next_chunk = chunk_start
                .checked_add(chunk_size)
                .and_then(|position| position.checked_add(chunk_size & 1))
                .ok_or_else(|| {
                    "A separated stem contains an invalid WAV chunk size.".to_string()
                })?;
            file.seek(SeekFrom::Start(next_chunk))
                .map_err(|error| format!("Could not seek in a separated stem: {error}"))?;
        }

        let (channels, sample_rate, _) = format
            .ok_or_else(|| "A separated stem is missing its WAV format header.".to_string())?;
        let (data_offset, data_bytes) =
            data.ok_or_else(|| "A separated stem is missing its WAV audio data.".to_string())?;
        if sample_rate == 0 {
            return Err("A separated stem has an invalid sample rate.".to_string());
        }
        let bytes_per_frame = u64::from(channels) * 2;
        if data_bytes == 0 || data_bytes % bytes_per_frame != 0 {
            return Err("A separated stem has an incomplete or empty audio frame.".to_string());
        }
        Ok(Self {
            file,
            data_offset,
            channels,
            sample_rate,
            frame_count: data_bytes / bytes_per_frame,
        })
    }

    fn read_frames(&mut self, start: u64, count: usize) -> Result<Vec<[f32; 2]>, String> {
        let end = start
            .checked_add(count as u64)
            .ok_or_else(|| "A requested instrumental phrase is too long.".to_string())?;
        if end > self.frame_count {
            return Err(
                "A separated stem is too short for the requested instrumental phrase.".to_string(),
            );
        }
        let bytes_per_frame = u64::from(self.channels) * 2;
        let byte_offset = self
            .data_offset
            .checked_add(start.saturating_mul(bytes_per_frame))
            .ok_or_else(|| "A separated stem contains an invalid audio offset.".to_string())?;
        self.file
            .seek(SeekFrom::Start(byte_offset))
            .map_err(|error| format!("Could not seek to an instrumental phrase: {error}"))?;
        let byte_count = count
            .checked_mul(bytes_per_frame as usize)
            .ok_or_else(|| "A requested instrumental phrase is too long.".to_string())?;
        let mut bytes = vec![0_u8; byte_count];
        self.file
            .read_exact(&mut bytes)
            .map_err(|error| format!("Could not read an instrumental phrase: {error}"))?;
        let mut frames = Vec::with_capacity(count);
        for sample_frame in bytes.chunks_exact(bytes_per_frame as usize) {
            let left = i16::from_le_bytes([sample_frame[0], sample_frame[1]]) as f32 / 32768.0;
            let right = if self.channels == 2 {
                i16::from_le_bytes([sample_frame[2], sample_frame[3]]) as f32 / 32768.0
            } else {
                left
            };
            frames.push([left, right]);
        }
        Ok(frames)
    }
}

struct WaveOutput {
    file: File,
    sample_rate: u32,
    frames_written: u64,
}

impl WaveOutput {
    fn create(path: &Path, sample_rate: u32) -> Result<Self, String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| format!("Could not create the extended WAV file: {error}"))?;
        file.write_all(&[0_u8; WAV_HEADER_BYTES as usize])
            .map_err(|error| format!("Could not initialize the extended WAV file: {error}"))?;
        Ok(Self {
            file,
            sample_rate,
            frames_written: 0,
        })
    }

    fn write_frames(&mut self, frames: &[[f32; 2]]) -> Result<(), String> {
        if frames.is_empty() {
            return Ok(());
        }
        let next_frames = self
            .frames_written
            .checked_add(frames.len() as u64)
            .ok_or_else(|| "The extended WAV file is too large.".to_string())?;
        let data_bytes = next_frames
            .checked_mul(4)
            .ok_or_else(|| "The extended WAV file is too large.".to_string())?;
        if data_bytes > WAV_MAX_DATA_BYTES {
            return Err("The extended song exceeds the 4 GB WAV format limit.".to_string());
        }
        let mut bytes = Vec::with_capacity(frames.len() * 4);
        for frame in frames {
            for sample in frame {
                let bounded = if sample.is_finite() {
                    sample.clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                let pcm = (bounded * 32767.0).round() as i16;
                bytes.extend_from_slice(&pcm.to_le_bytes());
            }
        }
        self.file
            .write_all(&bytes)
            .map_err(|error| format!("Could not write the extended WAV audio: {error}"))?;
        self.frames_written = next_frames;
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        let data_bytes = self.frames_written * 4;
        let riff_size = u32::try_from(36 + data_bytes)
            .map_err(|_| "The extended song exceeds the 4 GB WAV format limit.".to_string())?;
        let byte_rate = self
            .sample_rate
            .checked_mul(4)
            .ok_or_else(|| "The sample rate is too large for a standard WAV file.".to_string())?;
        let mut header = Vec::with_capacity(WAV_HEADER_BYTES as usize);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&riff_size.to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16_u32.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&2_u16.to_le_bytes());
        header.extend_from_slice(&self.sample_rate.to_le_bytes());
        header.extend_from_slice(&byte_rate.to_le_bytes());
        header.extend_from_slice(&4_u16.to_le_bytes());
        header.extend_from_slice(&16_u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&(data_bytes as u32).to_le_bytes());
        self.file
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.file.write_all(&header))
            .and_then(|_| self.file.flush())
            .and_then(|_| self.file.sync_all())
            .map_err(|error| format!("Could not finalize the extended WAV file: {error}"))
    }
}

struct StreamingResampler {
    source_rate: u32,
    target_rate: u32,
    input: Vec<[f32; 2]>,
    input_start: u64,
    total_input: u64,
    next_output: u64,
}

impl StreamingResampler {
    fn new(source_rate: u32, target_rate: u32) -> Result<Self, String> {
        if source_rate == 0 || target_rate == 0 {
            return Err("The audio source has an invalid sample rate.".to_string());
        }
        Ok(Self {
            source_rate,
            target_rate,
            input: Vec::new(),
            input_start: 0,
            total_input: 0,
            next_output: 0,
        })
    }

    fn push(&mut self, frames: &[[f32; 2]], output: &mut WaveOutput) -> Result<(), String> {
        self.input.extend_from_slice(frames);
        self.total_input = self
            .total_input
            .checked_add(frames.len() as u64)
            .ok_or_else(|| "The source track is too long to export.".to_string())?;
        let mut converted = Vec::new();
        loop {
            let numerator = u128::from(self.next_output) * u128::from(self.source_rate);
            let first = (numerator / u128::from(self.target_rate)) as u64;
            if first.saturating_add(1) >= self.total_input {
                break;
            }
            let fraction =
                (numerator % u128::from(self.target_rate)) as f32 / self.target_rate as f32;
            let first_frame = self.input[(first - self.input_start) as usize];
            let second_frame = self.input[(first + 1 - self.input_start) as usize];
            converted.push([
                first_frame[0] + (second_frame[0] - first_frame[0]) * fraction,
                first_frame[1] + (second_frame[1] - first_frame[1]) * fraction,
            ]);
            self.next_output += 1;
        }
        output.write_frames(&converted)?;
        self.discard_consumed_input();
        Ok(())
    }

    fn finish(&mut self, output: &mut WaveOutput) -> Result<(), String> {
        if self.total_input == 0 {
            return Err("The selected audio file contains no decodable samples.".to_string());
        }
        let target_frames = ((u128::from(self.total_input) * u128::from(self.target_rate)
            + u128::from(self.source_rate) / 2)
            / u128::from(self.source_rate)) as u64;
        let last = self.input[(self.total_input - 1 - self.input_start) as usize];
        let mut converted = Vec::new();
        while self.next_output < target_frames {
            let numerator = u128::from(self.next_output) * u128::from(self.source_rate);
            let first =
                ((numerator / u128::from(self.target_rate)) as u64).min(self.total_input - 1);
            let fraction =
                (numerator % u128::from(self.target_rate)) as f32 / self.target_rate as f32;
            let first_frame = self.input[(first - self.input_start) as usize];
            let second_frame = if first + 1 < self.total_input {
                self.input[(first + 1 - self.input_start) as usize]
            } else {
                last
            };
            converted.push([
                first_frame[0] + (second_frame[0] - first_frame[0]) * fraction,
                first_frame[1] + (second_frame[1] - first_frame[1]) * fraction,
            ]);
            self.next_output += 1;
            if converted.len() >= MIX_CHUNK_FRAMES {
                output.write_frames(&converted)?;
                converted.clear();
            }
        }
        output.write_frames(&converted)
    }

    fn discard_consumed_input(&mut self) {
        let numerator = u128::from(self.next_output) * u128::from(self.source_rate);
        let next_first = (numerator / u128::from(self.target_rate)) as u64;
        let keep_from = next_first.min(self.total_input.saturating_sub(1));
        let discard = keep_from.saturating_sub(self.input_start) as usize;
        if discard > 0 {
            self.input.drain(..discard);
            self.input_start += discard as u64;
        }
    }
}

fn authorize_stems(app: &AppHandle, paths: InstrumentalStemPaths) -> Result<[PathBuf; 3], String> {
    let stem_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate local stem storage: {error}"))?
        .join("stems");
    let stem_root = fs::canonicalize(stem_root)
        .map_err(|error| format!("The separated stem cache is no longer available: {error}"))?;
    let requested = [paths.drums, paths.bass, paths.other];
    let expected = ["drums.wav", "bass.wav", "other.wav"];
    let mut authorized = Vec::with_capacity(3);
    let mut common_parent: Option<PathBuf> = None;
    for (path, expected_name) in requested.into_iter().zip(expected) {
        let canonical = fs::canonicalize(path)
            .map_err(|error| format!("Could not open the cached {expected_name} stem: {error}"))?;
        if !canonical.starts_with(&stem_root)
            || canonical.file_name().and_then(|name| name.to_str()) != Some(expected_name)
            || !canonical.is_file()
        {
            return Err(
                "Song extension can only use stems from the local separation cache.".to_string(),
            );
        }
        let parent = canonical
            .parent()
            .ok_or_else(|| "A cached stem path is invalid.".to_string())?
            .to_path_buf();
        if common_parent
            .as_ref()
            .is_some_and(|expected_parent| expected_parent != &parent)
        {
            return Err("The selected stems must come from the same separated track.".to_string());
        }
        common_parent = Some(parent);
        authorized.push(canonical);
    }
    authorized
        .try_into()
        .map_err(|_| "Could not validate the three instrumental stems.".to_string())
}

fn phrase_window(
    total_frames: u64,
    sample_rate: u32,
    bpm: f64,
    bars: u8,
    anchor_seconds: f64,
) -> Result<(u64, u64), String> {
    if !(40.0..=300.0).contains(&bpm) || !bpm.is_finite() {
        return Err("Set a valid track BPM between 40 and 300 before exporting.".to_string());
    }
    if bars != 8 && bars != 16 {
        return Err("Choose either an 8-bar or 16-bar song extension.".to_string());
    }
    let bar_frames = f64::from(sample_rate) * 240.0 / bpm;
    let phrase_frames = (bar_frames * f64::from(bars)).round() as u64;
    let anchor = if anchor_seconds.is_finite() && anchor_seconds >= 0.0 {
        (anchor_seconds * f64::from(sample_rate)).round() as u64
    } else {
        0
    };
    if phrase_frames == 0 || anchor.saturating_add(phrase_frames) > total_frames {
        return Err(format!(
            "This track is too short to build an instrumental {bars}-bar phrase at {bpm:.1} BPM."
        ));
    }
    let latest_start = total_frames - phrase_frames;
    let aligned_bars = ((latest_start.saturating_sub(anchor)) as f64 / bar_frames)
        .floor()
        .max(0.0);
    let mut outro_start = anchor + (aligned_bars * bar_frames).round() as u64;
    while outro_start.saturating_add(phrase_frames) > total_frames && outro_start >= anchor {
        outro_start = outro_start.saturating_sub(bar_frames.round() as u64);
    }
    if outro_start < anchor {
        return Err("This track is too short to find a beat-aligned outro phrase.".to_string());
    }
    Ok((anchor, outro_start))
}

fn append_instrumental_phrase(
    stems: &mut [Pcm16Wave; 3],
    start: u64,
    length: u64,
    output: &mut WaveOutput,
) -> Result<(), String> {
    let mut offset = 0_u64;
    while offset < length {
        let count = (length - offset).min(MIX_CHUNK_FRAMES as u64) as usize;
        let drums = stems[0].read_frames(start + offset, count)?;
        let bass = stems[1].read_frames(start + offset, count)?;
        let other = stems[2].read_frames(start + offset, count)?;
        let mix = drums
            .iter()
            .zip(&bass)
            .zip(&other)
            .map(|((drum, bass), other)| {
                [
                    (drum[0] + bass[0] + other[0]).tanh(),
                    (drum[1] + bass[1] + other[1]).tanh(),
                ]
            })
            .collect::<Vec<_>>();
        output.write_frames(&mix)?;
        offset += count as u64;
    }
    Ok(())
}

fn append_original_track(path: &Path, output: &mut WaveOutput) -> Result<u64, String> {
    let file = File::open(path)
        .map_err(|error| format!("Could not open the original audio track: {error}"))?;
    let media = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = get_probe()
        .format(
            &Hint::new(),
            media,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| {
            format!(
                "Could not read the original audio. Intro/outro generation supports WAV, MP3, FLAC, M4A, and OGG files; the file may also be damaged. ({error})"
            )
        })?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "The original audio file does not contain a playable track.".to_string())?;
    let track_id = track.id;
    let source_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| "The original track does not report a sample rate.".to_string())?;
    let mut decoder = get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| {
            format!(
                "This audio codec is not supported for intro/outro generation. Use WAV, MP3, FLAC, M4A, or OGG. ({error})"
            )
        })?;
    let start_frames = output.frames_written;
    let mut resampler = StreamingResampler::new(source_rate, output.sample_rate)?;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error)) if error.kind() == ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                return Err(
                    "The original file requires an unsupported audio decoder reset.".to_string(),
                );
            }
            Err(error) => return Err(format!("Could not read the original audio track: {error}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|error| format!("Could not decode the original audio track: {error}"))?;
        let channels = decoded.spec().channels.count();
        if channels == 0 || decoded.spec().rate != source_rate {
            return Err(
                "The original track changed to an unsupported audio format while decoding."
                    .to_string(),
            );
        }
        let mut converted = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        converted.copy_interleaved_ref(decoded);
        let stereo_frames = converted
            .samples()
            .chunks(channels)
            .map(|frame| {
                let left = frame[0];
                [left, frame.get(1).copied().unwrap_or(left)]
            })
            .collect::<Vec<_>>();
        resampler.push(&stereo_frames, output)?;
    }
    resampler.finish(output)?;
    Ok(output.frames_written - start_frames)
}

fn build_extended_wav(
    source_path: &Path,
    stem_paths: [&Path; 3],
    output_path: &Path,
    bpm: f64,
    bars: u8,
    beat_grid_seconds: &[f64],
) -> Result<(), String> {
    if beat_grid_seconds.len() > 1000 {
        return Err("The beat grid contains too many markers.".to_string());
    }
    if !bpm.is_finite() || !(40.0..=300.0).contains(&bpm) {
        return Err("Set a valid track BPM between 40 and 300 before exporting.".to_string());
    }
    if bars != 8 && bars != 16 {
        return Err("Choose either an 8-bar or 16-bar song extension.".to_string());
    }
    let mut stems = [
        Pcm16Wave::open(stem_paths[0])?,
        Pcm16Wave::open(stem_paths[1])?,
        Pcm16Wave::open(stem_paths[2])?,
    ];
    if stems[0].sample_rate != stems[1].sample_rate
        || stems[0].sample_rate != stems[2].sample_rate
        || stems[0].frame_count != stems[1].frame_count
        || stems[0].frame_count != stems[2].frame_count
    {
        return Err("The cached instrumental stems are not synchronized.".to_string());
    }
    let anchor = beat_grid_seconds
        .iter()
        .copied()
        .filter(|beat| beat.is_finite() && *beat >= 0.0)
        .min_by(f64::total_cmp)
        .unwrap_or(0.0);
    let (intro_start, outro_start) = phrase_window(
        stems[0].frame_count,
        stems[0].sample_rate,
        bpm,
        bars,
        anchor,
    )?;
    let phrase_frames =
        (f64::from(stems[0].sample_rate) * 240.0 / bpm * f64::from(bars)).round() as u64;
    let mut output = WaveOutput::create(output_path, stems[0].sample_rate)?;
    append_instrumental_phrase(&mut stems, intro_start, phrase_frames, &mut output)?;
    let original_frames = append_original_track(source_path, &mut output)?;
    let frame_difference = original_frames.abs_diff(stems[0].frame_count);
    if frame_difference > 1 {
        return Err(
            "The separated stems do not match the original track's duration. Separate this track again before exporting."
                .to_string(),
        );
    }
    append_instrumental_phrase(&mut stems, outro_start, phrase_frames, &mut output)?;
    output.finish()
}

fn unique_sibling_path(path: &Path, purpose: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Choose a valid WAV output filename.".to_string())?;
    Ok(parent.join(format!(".{name}.{}-{}.tmp", purpose, uuid::Uuid::new_v4())))
}

fn commit_output(temp_path: &Path, output_path: &Path) -> Result<(), String> {
    if output_path.exists() {
        let backup_path = unique_sibling_path(output_path, "backup")?;
        fs::rename(output_path, &backup_path).map_err(|error| {
            format!("Could not safely replace the selected output file: {error}")
        })?;
        if let Err(error) = fs::rename(temp_path, output_path) {
            return match fs::rename(&backup_path, output_path) {
                Ok(()) => Err(format!("Could not save the extended WAV file: {error}")),
                Err(restore_error) => Err(format!(
                    "Could not save the extended WAV file ({error}); the previous output is preserved at '{}', but restoring its original name failed ({restore_error}).",
                    backup_path.display()
                )),
            };
        }
        let _ = fs::remove_file(backup_path);
        Ok(())
    } else {
        fs::rename(temp_path, output_path)
            .map_err(|error| format!("Could not save the extended WAV file: {error}"))
    }
}

fn ensure_extension_audio_supported(path: &Path) -> Result<(), String> {
    let supported = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| {
            matches!(
                extension.as_str(),
                "wav" | "mp3" | "flac" | "m4a" | "mp4" | "ogg"
            )
        });
    if supported {
        Ok(())
    } else {
        Err(
            "Intro/outro generation does not support this audio format yet. Use WAV, MP3, FLAC, M4A, or OGG."
                .to_string(),
        )
    }
}

fn create_extended_song_from_source(
    app: &AppHandle,
    source_path: &Path,
    stem_paths: InstrumentalStemPaths,
    bpm: f64,
    bars: u8,
    beat_grid_seconds: Vec<f64>,
    output_path: String,
) -> Result<String, String> {
    ensure_extension_audio_supported(source_path)?;
    let stems = authorize_stems(app, stem_paths)?;
    let destination = PathBuf::from(output_path);
    if destination
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        != Some("wav".to_string())
    {
        return Err("Choose a WAV file for the extended song.".to_string());
    }
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !parent.is_dir() {
        return Err("The selected output folder is no longer available.".to_string());
    }
    if destination.exists() && !destination.is_file() {
        return Err("Choose a WAV filename, not a folder.".to_string());
    }
    if destination.exists()
        && fs::canonicalize(&destination)
            .map_err(|error| format!("Could not validate the selected output file: {error}"))?
            == fs::canonicalize(source_path)
                .map_err(|error| format!("Could not validate the original audio file: {error}"))?
    {
        return Err(
            "Choose a different output filename; the original track will not be overwritten."
                .to_string(),
        );
    }

    let temporary = unique_sibling_path(&destination, "extension")?;
    let result = build_extended_wav(
        source_path,
        [&stems[0], &stems[1], &stems[2]],
        &temporary,
        bpm,
        bars,
        &beat_grid_seconds,
    );
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = commit_output(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn create_extended_song(
    app: AppHandle,
    track_path: String,
    stem_paths: InstrumentalStemPaths,
    bpm: f64,
    bars: u8,
    beat_grid_seconds: Vec<f64>,
    output_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let authorized_track = super::authorize_track_file(app.clone(), track_path)?;
        create_extended_song_from_source(
            &app,
            Path::new(&authorized_track),
            stem_paths,
            bpm,
            bars,
            beat_grid_seconds,
            output_path,
        )
    })
    .await
    .map_err(|error| format!("The song extension job could not finish: {error}"))?
}

#[tauri::command]
pub async fn create_extended_song_from_audio(
    app: AppHandle,
    file_name: String,
    audio_bytes: Vec<u8>,
    stem_paths: InstrumentalStemPaths,
    bpm: f64,
    bars: u8,
    beat_grid_seconds: Vec<f64>,
    output_path: String,
) -> Result<String, String> {
    let imported_audio =
        super::imported_audio::write_imported_audio(&app, &file_name, &audio_bytes)?;
    let source_path = imported_audio.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let _temporary_source = imported_audio;
        create_extended_song_from_source(
            &app,
            &source_path,
            stem_paths,
            bpm,
            bars,
            beat_grid_seconds,
            output_path,
        )
    })
    .await
    .map_err(|error| format!("The song extension job could not finish: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        build_extended_wav, ensure_extension_audio_supported, phrase_window, Pcm16Wave, WaveOutput,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "drop-theory-extension-{label}-{}.wav",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn intro_outro_reports_unsupported_file_formats_clearly() {
        assert!(ensure_extension_audio_supported(Path::new("track.wav")).is_ok());
        assert!(ensure_extension_audio_supported(Path::new("track.flac")).is_ok());
        let error = ensure_extension_audio_supported(Path::new("track.aiff"))
            .expect_err("AIFF is not supported by the extension decoder");
        assert!(error.contains("does not support"));
        assert!(error.contains("WAV, MP3, FLAC"));
    }

    fn write_test_wave_at_rate(path: &PathBuf, sample_rate: u32, frames: &[[f32; 2]]) {
        let mut writer = WaveOutput::create(path, sample_rate).expect("create test WAV");
        writer.write_frames(frames).expect("write test samples");
        writer.finish().expect("finish test WAV");
    }

    fn write_test_wave(path: &PathBuf, frames: &[[f32; 2]]) {
        write_test_wave_at_rate(path, 100, frames);
    }

    #[test]
    fn phrase_windows_are_beat_anchored_for_both_supported_lengths() {
        let (intro_8, outro_8) = phrase_window(100_000, 1_000, 120.0, 8, 1.25).unwrap();
        assert_eq!(intro_8, 1_250);
        assert_eq!(outro_8, 83_250);
        let (_, outro_16) = phrase_window(100_000, 1_000, 120.0, 16, 1.25).unwrap();
        assert_eq!(outro_16, 67_250);
        assert!(phrase_window(100_000, 1_000, 120.0, 4, 0.0).is_err());
    }

    #[test]
    fn export_adds_instrumental_phrases_and_keeps_the_complete_source_in_between() {
        let source = temp_path("source");
        let drums_path = temp_path("drums");
        let bass_path = temp_path("bass");
        let other_path = temp_path("other");
        let output_path = temp_path("output");
        let source_frames = (0..800)
            .map(|index| {
                let value = (index as f32 / 800.0) * 0.4 - 0.2;
                [value, -value]
            })
            .collect::<Vec<_>>();
        let stem_frames = vec![[0.1, 0.1]; 800];
        write_test_wave(&source, &source_frames);
        write_test_wave(&drums_path, &stem_frames);
        write_test_wave(&bass_path, &vec![[0.05, 0.05]; 800]);
        write_test_wave(&other_path, &vec![[-0.025, -0.025]; 800]);
        let original_bytes = fs::read(&source).expect("read source before export");

        build_extended_wav(
            &source,
            [&drums_path, &bass_path, &other_path],
            &output_path,
            300.0,
            8,
            &[0.0, 0.2, 0.4],
        )
        .expect("build extended song");

        assert_eq!(
            fs::read(&source).expect("read source after export"),
            original_bytes
        );
        let mut exported = Pcm16Wave::open(&output_path).expect("open exported WAV");
        assert_eq!(exported.sample_rate, 100);
        assert_eq!(exported.frame_count, 2_080);
        let first_instrumental_frame = exported.read_frames(100, 1).unwrap()[0][0];
        assert!((first_instrumental_frame - 0.125_f32.tanh()).abs() < 0.0001);
        let first_original_frame = exported.read_frames(640, 1).unwrap()[0];
        assert!((first_original_frame[0] - source_frames[0][0]).abs() < 0.0001);
        assert!((first_original_frame[1] - source_frames[0][1]).abs() < 0.0001);
        let final_instrumental_frame = exported.read_frames(1_440, 1).unwrap()[0][0];
        assert!((final_instrumental_frame - 0.125_f32.tanh()).abs() < 0.0001);

        for path in [source, drums_path, bass_path, other_path, output_path] {
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn export_resamples_the_original_to_the_stem_sample_rate() {
        let source = temp_path("resample-source");
        let drums_path = temp_path("resample-drums");
        let bass_path = temp_path("resample-bass");
        let other_path = temp_path("resample-other");
        let output_path = temp_path("resample-output");
        write_test_wave_at_rate(&source, 200, &vec![[0.2, -0.2]; 1_600]);
        write_test_wave(&drums_path, &vec![[0.1, 0.1]; 800]);
        write_test_wave(&bass_path, &vec![[0.05, 0.05]; 800]);
        write_test_wave(&other_path, &vec![[-0.025, -0.025]; 800]);

        build_extended_wav(
            &source,
            [&drums_path, &bass_path, &other_path],
            &output_path,
            300.0,
            8,
            &[],
        )
        .expect("build resampled extended song");

        let mut exported = Pcm16Wave::open(&output_path).expect("open resampled WAV");
        assert_eq!(exported.sample_rate, 100);
        assert_eq!(exported.frame_count, 2_080);
        let source_section = exported.read_frames(640, 1).unwrap()[0];
        assert!((source_section[0] - 0.2).abs() < 0.0001);
        assert!((source_section[1] + 0.2).abs() < 0.0001);

        for path in [source, drums_path, bass_path, other_path, output_path] {
            let _ = fs::remove_file(path);
        }
    }
}
