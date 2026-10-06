use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State, WebviewWindow};

const RUNNER: &str = include_str!("stem_runner.py");
const SETTINGS_FILE: &str = "stem-settings.json";
const UVR_SEPARATOR_VERSION: &str = "uvr-mdx-net-inst-hq5-v1";
#[cfg(test)]
const LICENSES: [&str; 7] = [
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    "CC0-1.0",
];
const STEMS: [&str; 2] = ["vocals", "instrumental"];

fn default_uvr_overlap() -> f64 {
    0.25
}

fn resolve_uvr_overlap(value: f64) -> Result<f64, String> {
    [0.25, 0.50, 0.75, 0.99]
        .into_iter()
        .find(|supported| (value - supported).abs() < 0.000_001)
        .ok_or_else(|| "Choose a supported UVR overlap setting.".to_string())
}

fn spawn_with_stdin(command: &mut Command, source: &[u8]) -> io::Result<Child> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let write_result = match child.stdin.take() {
        Some(mut stdin) => stdin.write_all(source),
        None => Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "The Python runner input pipe was not available.",
        )),
    };
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

fn spawn_stem_runner(command: &mut Command) -> io::Result<Child> {
    spawn_with_stdin(command, RUNNER.as_bytes())
}

fn safe_export_name(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .take(100)
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '-'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|character: char| character == '.' || character == ' ');
    if cleaned.is_empty() {
        "Track".to_string()
    } else {
        cleaned.to_string()
    }
}

fn unique_export_directory(parent: &Path, name: &str) -> Result<PathBuf, String> {
    for suffix in 1..=10_000 {
        let directory_name = if suffix == 1 {
            format!("{name} - Stems")
        } else {
            format!("{name} - Stems ({suffix})")
        };
        let directory = parent.join(directory_name);
        match fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the stem export folder: {error}")),
        }
    }
    Err("Could not find an available name for the stem export folder.".to_string())
}

fn copy_selected_stems(
    cache_root: &Path,
    stem_paths: &HashMap<String, String>,
    selected_stems: &[String],
    output_directory: &Path,
    track_name: &str,
) -> Result<String, String> {
    if selected_stems.is_empty() || selected_stems.len() > STEMS.len() {
        return Err("Choose at least one stem to export.".to_string());
    }
    let cache_root = fs::canonicalize(cache_root)
        .map_err(|error| format!("Could not locate the local stem cache: {error}"))?;
    let output_directory = fs::canonicalize(output_directory)
        .map_err(|error| format!("Could not open the selected export folder: {error}"))?;
    if !output_directory.is_dir() {
        return Err("Choose an existing folder for the stem export.".to_string());
    }

    let mut seen: Vec<&str> = Vec::new();
    let mut source_paths = Vec::with_capacity(selected_stems.len());
    let mut source_directory: Option<PathBuf> = None;
    for stem in selected_stems {
        let stem_name = stem.as_str();
        if !STEMS.contains(&stem_name) || seen.contains(&stem_name) {
            return Err("The selected stem list is invalid.".to_string());
        }
        seen.push(stem_name);
        let path = stem_paths
            .get(stem)
            .ok_or_else(|| format!("The {stem} stem is not available for export."))?;
        let source = fs::canonicalize(path)
            .map_err(|error| format!("Could not open the {stem} stem: {error}"))?;
        let expected_name = format!("{stem}.wav");
        if !source.is_file()
            || !source.starts_with(&cache_root)
            || source.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
        {
            return Err(format!("The {stem} stem is not a valid cached WAV file."));
        }
        let parent = source
            .parent()
            .ok_or_else(|| format!("The {stem} stem has no cache folder."))?;
        if source_directory
            .as_ref()
            .is_some_and(|directory| directory.as_path() != parent)
        {
            return Err(
                "The selected stems do not belong to the same separated track.".to_string(),
            );
        }
        source_directory = Some(parent.to_path_buf());
        source_paths.push((stem_name, source));
    }
    let source_directory =
        source_directory.ok_or_else(|| "No separated stem files were selected.".to_string())?;
    if !cache_has_stems(&source_directory) {
        return Err(
            "The cached stem set is incomplete. Separate this track again before exporting."
                .to_string(),
        );
    }

    let destination = unique_export_directory(&output_directory, &safe_export_name(track_name))?;
    for (stem, source) in source_paths {
        let target = destination.join(format!("{stem}.wav"));
        if let Err(error) = fs::copy(&source, &target) {
            let _ = fs::remove_dir_all(&destination);
            return Err(format!("Could not export the {stem} stem: {error}"));
        }
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn export_separated_stems(
    app: AppHandle,
    stem_paths: HashMap<String, String>,
    selected_stems: Vec<String>,
    output_directory: String,
    track_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?;
        let cache_root = separation_cache_root(&app_data_dir);
        copy_selected_stems(
            &cache_root,
            &stem_paths,
            &selected_stems,
            Path::new(&output_directory),
            &track_name,
        )
    })
    .await
    .map_err(|error| format!("The stem export worker stopped unexpectedly: {error}"))?
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemSettings {
    pub model_choice: Option<String>,
    #[serde(default = "default_uvr_overlap")]
    pub overlap: f64,
}

impl Default for StemSettings {
    fn default() -> Self {
        Self {
            model_choice: None,
            overlap: default_uvr_overlap(),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StemManifest {
    format: String,
    version: u32,
    model_id: String,
    model_license: String,
    weights_license: String,
    model_license_file: String,
    weights_license_file: String,
    model_file: String,
    sample_rate: u32,
    channels: u32,
    chunk_samples: usize,
    input_name: String,
    output_names: StemOutputs,
}

#[cfg(test)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StemOutputs {
    vocals: String,
    drums: String,
    bass: String,
    other: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompatibility {
    compatible: bool,
    message: String,
    models_bundled: bool,
    models_cached: bool,
    model_id: Option<String>,
    model_license: Option<String>,
    weights_license: Option<String>,
    runtime_version: Option<String>,
    execution_provider: Option<String>,
}

impl ModelCompatibility {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            compatible: false,
            message: message.into(),
            models_bundled: false,
            models_cached: false,
            model_id: None,
            model_license: None,
            weights_license: None,
            runtime_version: None,
            execution_provider: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeparationEvent {
    job_id: String,
    status: String,
    percent: u8,
    message: String,
    stems: Option<HashMap<String, String>>,
    error: Option<String>,
}

#[derive(Default)]
pub struct StemJobs {
    jobs: Arc<Mutex<HashMap<String, Arc<JobControl>>>>,
    cache_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

struct JobControl {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

struct TemporaryDirectory {
    path: Option<PathBuf>,
}

impl TemporaryDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(mut self) {
        // The directory has been renamed into the final cache. Do not clean
        // up the moved directory when this guard is dropped.
        self.path = None;
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[tauri::command]
pub fn load_stem_settings(app: AppHandle) -> Result<StemSettings, String> {
    let settings_path = settings_path(&app)?;
    if !settings_path.exists() {
        return Ok(StemSettings::default());
    }
    let serialized = fs::read_to_string(settings_path)
        .map_err(|error| format!("Could not read stem settings: {error}"))?;
    serde_json::from_str(&serialized)
        .map_err(|error| format!("Saved stem settings are invalid: {error}"))
}

#[tauri::command]
pub fn save_stem_settings(app: AppHandle, settings: StemSettings) -> Result<(), String> {
    let settings = StemSettings {
        overlap: resolve_uvr_overlap(settings.overlap)?,
        ..settings
    };
    let path = settings_path(&app)?;
    let serialized = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Could not encode stem settings: {error}"))?;
    fs::write(path, serialized).map_err(|error| format!("Could not save stem settings: {error}"))
}

#[tauri::command]
pub fn inspect_stem_model(
    app: AppHandle,
    model_choice: String,
) -> Result<ModelCompatibility, String> {
    if let Err(error) = resolve_model_choice(&model_choice) {
        return Ok(ModelCompatibility::failed(error));
    }
    let (python, runtime) = bundled_stem_runtime(&app)?;
    let model_cache = model_cache_dir(&app)?;
    let bundled_models = bundled_stem_models(&app)?;
    let mut command = Command::new(&python);
    command
        .args(["-u", "-", "inspect-uvr"])
        .env("CRATEFORGE_STEM_RUNTIME", &runtime)
        .env("CRATEFORGE_UVR_MODEL_DIR", model_cache.join("uvr"));
    if let Some(model_directory) = bundled_models.as_ref() {
        command.env("CRATEFORGE_STEM_MODELS", model_directory);
    }
    let output = spawn_stem_runner(&mut command)
        .and_then(Child::wait_with_output)
        .map_err(|error| format!("Could not start the bundled Python runtime: {error}"))?;
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Ok(ModelCompatibility::failed(if message.is_empty() {
            "The bundled runtime could not load UVR inference. Repair or reinstall Drop Theory Pro."
                .to_string()
        } else {
            message
        }));
    }

    let runtime: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("The model checker returned invalid data: {error}"))?;
    if runtime.get("compatible").and_then(Value::as_bool) != Some(true) {
        return Ok(ModelCompatibility::failed(
            runtime
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The model does not match Drop Theory Pro's UVR HQ5 contract."),
        ));
    }

    let models_bundled = runtime
        .get("modelsBundled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let models_cached = runtime
        .get("modelsCached")
        .and_then(Value::as_bool)
        .unwrap_or(models_bundled);
    Ok(ModelCompatibility {
        compatible: true,
        message: if models_cached {
            "Runtime and selected model weights are ready for offline use.".to_string()
        } else {
            "Runtime ready. Model weights download to this device the first time you separate a track.".to_string()
        },
        models_bundled,
        models_cached,
        model_id: Some(model_choice),
        model_license: runtime
            .get("modelLicense")
            .and_then(Value::as_str)
            .map(str::to_string),
        weights_license: runtime
            .get("weightsLicense")
            .and_then(Value::as_str)
            .map(str::to_string),
        runtime_version: runtime
            .get("runtimeVersion")
            .and_then(Value::as_str)
            .map(str::to_string),
        execution_provider: runtime
            .get("executionProvider")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[tauri::command]
pub async fn download_stem_model(
    app: AppHandle,
    window: WebviewWindow,
    job_id: String,
    model_choice: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_model_choice(&model_choice)?;
        let (python, runtime) = bundled_stem_runtime(&app)?;
        let model_cache = model_cache_dir(&app)?;
        let bundled_models = bundled_stem_models(&app)?;
        let mut command = Command::new(python);
        command
            .args(["-u", "-", "download-uvr"])
            .env("CRATEFORGE_STEM_RUNTIME", runtime)
            .env("CRATEFORGE_UVR_MODEL_DIR", model_cache.join("uvr"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(model_directory) = bundled_models {
            command.env("CRATEFORGE_STEM_MODELS", model_directory);
        }
        let mut child = spawn_stem_runner(&mut command)
            .map_err(|error| format!("Could not start the model download: {error}"))?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The model download process did not provide output streams.".to_string());
        };
        let stderr_reader = thread::spawn(move || {
            let mut text = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut text);
            text
        });
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stderr_reader.join();
                    return Err(format!("Could not read model download progress: {error}"));
                }
            };
            if let Ok(progress) = serde_json::from_str::<Value>(&line) {
                if let Some(percent) = progress.get("percent").and_then(Value::as_u64) {
                    let _ = window.emit(
                        "stem-model-download",
                        serde_json::json!({
                            "jobId": job_id,
                            "percent": percent.min(100),
                            "message": progress.get("message").and_then(Value::as_str)
                                .unwrap_or("Downloading model weights…"),
                        }),
                    );
                }
            }
        }
        let status = child
            .wait()
            .map_err(|error| format!("Could not wait for the model download: {error}"))?;
        let diagnostics = stderr_reader.join().unwrap_or_default();
        if !status.success() {
            return Err(if diagnostics.trim().is_empty() {
                "The model download failed. Retry to resume using the local cache.".to_string()
            } else {
                diagnostics.trim().to_string()
            });
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("The model download worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub fn start_stem_separation(
    app: AppHandle,
    window: WebviewWindow,
    jobs: State<'_, StemJobs>,
    job_id: String,
    track_path: String,
    model_choice: String,
    overlap: f64,
) -> Result<(), String> {
    let authorized_track = super::authorize_track_file(app.clone(), track_path)?;
    start_stem_separation_job(
        app,
        window,
        jobs,
        job_id,
        PathBuf::from(authorized_track),
        model_choice,
        overlap,
        None,
    )
}

#[tauri::command]
pub fn start_stem_separation_from_audio(
    app: AppHandle,
    window: WebviewWindow,
    jobs: State<'_, StemJobs>,
    job_id: String,
    file_name: String,
    audio_bytes: Vec<u8>,
    model_choice: String,
    overlap: f64,
) -> Result<(), String> {
    if job_id.trim().is_empty() || job_id.len() > 128 {
        return Err("Invalid separation job identifier.".to_string());
    }
    let imported_audio =
        super::imported_audio::write_imported_audio(&app, &file_name, &audio_bytes)?;
    start_stem_separation_job(
        app,
        window,
        jobs,
        job_id,
        imported_audio.path().to_path_buf(),
        model_choice,
        overlap,
        Some(imported_audio),
    )
}

fn start_stem_separation_job(
    app: AppHandle,
    window: WebviewWindow,
    jobs: State<'_, StemJobs>,
    job_id: String,
    track: PathBuf,
    model_choice: String,
    overlap: f64,
    temporary_source: Option<super::imported_audio::TemporaryImportedAudio>,
) -> Result<(), String> {
    if job_id.trim().is_empty() || job_id.len() > 128 {
        return Err("Invalid separation job identifier.".to_string());
    }
    let overlap = resolve_uvr_overlap(overlap)?;
    resolve_model_choice(&model_choice)?;
    let (python, runtime) = bundled_stem_runtime(&app)?;
    let model_cache = model_cache_dir(&app)?;
    let key = catalog_cache_key(&track, &model_choice, overlap)?;
    let cache_lock = {
        let mut locks = jobs
            .cache_locks
            .lock()
            .map_err(|_| "Stem cache registry is unavailable.".to_string())?;
        Arc::clone(
            locks
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?;
    let cache = separation_cache_root(&app_data).join(key);

    let control = Arc::new(JobControl {
        cancelled: AtomicBool::new(false),
        child: Mutex::new(None),
    });
    let job_registry = Arc::clone(&jobs.jobs);
    let cache_locks = Arc::clone(&jobs.cache_locks);
    {
        let mut active_jobs = jobs
            .jobs
            .lock()
            .map_err(|_| "Stem job registry is unavailable.".to_string())?;
        if active_jobs.contains_key(&job_id) {
            return Err("A separation job with this identifier is already running.".to_string());
        }
        active_jobs.insert(job_id.clone(), Arc::clone(&control));
    }

    thread::spawn(move || {
        let _temporary_source = temporary_source;
        let result = {
            let _cache_guard = cache_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            run_separation(
                &app,
                &window,
                &job_id,
                &track,
                &model_choice,
                overlap,
                &python,
                &runtime,
                &model_cache,
                &cache,
                &control,
            )
        };
        {
            let mut locks = cache_locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if Arc::strong_count(&cache_lock) == 2 {
                locks.retain(|_, lock| !Arc::ptr_eq(lock, &cache_lock));
            }
        }
        let mut active_jobs = job_registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active_jobs.remove(&job_id);
        if let Err(error) = result {
            let _ = emit_event(
                &window,
                SeparationEvent {
                    job_id,
                    status: if control.cancelled.load(Ordering::SeqCst) {
                        "cancelled".to_string()
                    } else {
                        "error".to_string()
                    },
                    percent: 0,
                    message: error.clone(),
                    stems: None,
                    error: Some(error),
                },
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_stem_separation(jobs: State<'_, StemJobs>, job_id: String) -> Result<(), String> {
    let active_jobs = jobs
        .jobs
        .lock()
        .map_err(|_| "Stem job registry is unavailable.".to_string())?;
    let control = active_jobs
        .get(&job_id)
        .ok_or_else(|| "This separation job is no longer running.".to_string())?;
    control.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut child) = control.child.lock() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

fn run_separation(
    app: &AppHandle,
    window: &WebviewWindow,
    job_id: &str,
    track: &Path,
    model_choice: &str,
    overlap: f64,
    python: &Path,
    runtime: &Path,
    model_cache: &Path,
    cache: &Path,
    control: &Arc<JobControl>,
) -> Result<(), String> {
    if control.cancelled.load(Ordering::SeqCst) {
        let _ = emit_event(
            window,
            SeparationEvent {
                job_id: job_id.to_string(),
                status: "cancelled".to_string(),
                percent: 0,
                message: "Separation cancelled.".to_string(),
                stems: None,
                error: None,
            },
        );
        return Ok(());
    }
    if cache_has_stems(cache) {
        return finish_job(app, window, job_id, cache);
    }
    let bundled_models = bundled_stem_models(app)?;
    emit_progress(
        window,
        job_id,
        0,
        if bundled_models.is_some() {
            "Loading the local runtime and bundled UVR model…"
        } else {
            "Loading the local runtime; the UVR model downloads on first use…"
        },
    );
    let parent = cache
        .parent()
        .ok_or_else(|| "Could not create the local stem cache.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Could not create stem cache: {error}"))?;
    let temporary = parent.join(format!("work-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temporary)
        .map_err(|error| format!("Could not prepare stem output: {error}"))?;
    let temporary_guard = TemporaryDirectory::new(temporary.clone());
    if control.cancelled.load(Ordering::SeqCst) {
        emit_cancelled(window, job_id);
        return Ok(());
    }

    let mut command = Command::new(python);
    command
        .args(["-u", "-", "separate-uvr"])
        .arg(overlap.to_string())
        .arg(track)
        .arg(&temporary)
        .env("CRATEFORGE_STEM_RUNTIME", runtime)
        .env("CRATEFORGE_UVR_MODEL_DIR", model_cache.join("uvr"))
        .env("OMP_NUM_THREADS", "4")
        .env("MKL_NUM_THREADS", "4")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(model_directory) = bundled_models.as_ref() {
        command.env("CRATEFORGE_STEM_MODELS", model_directory);
    }
    let mut child = spawn_stem_runner(&mut command)
        .map_err(|error| format!("Could not start local separation: {error}"))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            return Err(
                "The local separation process did not provide progress output.".to_string(),
            );
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            return Err("The local separation process did not provide diagnostics.".to_string());
        }
    };
    {
        let mut active_child = match control.child.lock() {
            Ok(child) => child,
            Err(_) => {
                let _ = child.kill();
                return Err("Could not manage the local separation process.".to_string());
            }
        };
        *active_child = Some(child);
    }

    let (line_sender, line_receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            let _ = line_sender.send(line);
        }
    });
    let stderr_reader = thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });

    let exit_status = loop {
        if control.cancelled.load(Ordering::SeqCst) {
            if let Ok(mut active_child) = control.child.lock() {
                if let Some(child) = active_child.as_mut() {
                    let _ = child.kill();
                }
            }
        }
        while let Ok(line) = line_receiver.try_recv() {
            if let Ok(progress) = serde_json::from_str::<Value>(&line) {
                if let Some(percent) = progress.get("percent").and_then(Value::as_u64) {
                    emit_progress(
                        window,
                        job_id,
                        percent.min(100) as u8,
                        progress
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Separating stems…"),
                    );
                }
            }
        }
        let status = {
            let mut active_child = control
                .child
                .lock()
                .map_err(|_| "Could not monitor the local separation process.".to_string())?;
            active_child
                .as_mut()
                .ok_or_else(|| "The local separation process stopped unexpectedly.".to_string())?
                .try_wait()
                .map_err(|error| format!("Could not monitor local separation: {error}"))?
        };
        if let Some(status) = status {
            break status;
        }
        thread::sleep(Duration::from_millis(100));
    };
    if let Ok(mut active_child) = control.child.lock() {
        *active_child = None;
    }
    let stderr = stderr_reader.join().unwrap_or_default();
    if control.cancelled.load(Ordering::SeqCst) {
        let _ = fs::remove_dir_all(&temporary);
        let _ = emit_event(
            window,
            SeparationEvent {
                job_id: job_id.to_string(),
                status: "cancelled".to_string(),
                percent: 0,
                message: "Separation cancelled.".to_string(),
                stems: None,
                error: None,
            },
        );
        return Ok(());
    }
    if !exit_status.success() {
        return Err(if stderr.trim().is_empty() {
            format!("The {model_choice} model failed during local separation.")
        } else {
            stderr.trim().to_string()
        });
    }
    if !cache_has_stems(&temporary) {
        return Err(
            "The separator finished without creating both valid UVR stem files.".to_string(),
        );
    }
    if cache.exists() {
        fs::remove_dir_all(cache)
            .map_err(|error| format!("Could not replace stem cache: {error}"))?;
    }
    fs::rename(&temporary, cache)
        .map_err(|error| format!("Could not save separated audio to the local cache: {error}"))?;
    temporary_guard.disarm();
    finish_job(app, window, job_id, cache)
}

fn finish_job(
    app: &AppHandle,
    window: &WebviewWindow,
    job_id: &str,
    cache: &Path,
) -> Result<(), String> {
    let mut paths = HashMap::new();
    for name in STEMS {
        let path = fs::canonicalize(cache.join(format!("{name}.wav")))
            .map_err(|error| format!("Could not open cached {name} stem: {error}"))?;
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| format!("Could not authorize cached audio: {error}"))?;
        paths.insert(name.to_string(), path.to_string_lossy().into_owned());
    }
    emit_event(
        window,
        SeparationEvent {
            job_id: job_id.to_string(),
            status: "complete".to_string(),
            percent: 100,
            message: "UVR vocals and instrumental stems are ready from the local cache."
                .to_string(),
            stems: Some(paths),
            error: None,
        },
    )
}

fn emit_progress(window: &WebviewWindow, job_id: &str, percent: u8, message: &str) {
    let _ = emit_event(
        window,
        SeparationEvent {
            job_id: job_id.to_string(),
            status: "running".to_string(),
            percent,
            message: message.to_string(),
            stems: None,
            error: None,
        },
    );
}

fn emit_cancelled(window: &WebviewWindow, job_id: &str) {
    let _ = emit_event(
        window,
        SeparationEvent {
            job_id: job_id.to_string(),
            status: "cancelled".to_string(),
            percent: 0,
            message: "Separation cancelled before the local process started.".to_string(),
            stems: None,
            error: None,
        },
    );
}

fn emit_event(window: &WebviewWindow, event: SeparationEvent) -> Result<(), String> {
    window
        .emit("stem-separation", event)
        .map_err(|error| format!("Could not update stem separation status: {error}"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("Could not create Drop Theory Pro app data: {error}"))?;
    Ok(data_dir.join(SETTINGS_FILE))
}

fn resolve_model_choice(choice: &str) -> Result<(), String> {
    match choice {
        "uvr-mdx-inst-hq-5" => Ok(()),
        _ => Err("Choose the supported UVR MDX-Net Inst HQ 5 model.".to_string()),
    }
}

fn bundled_stem_runtime(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let python = app
        .path()
        .resolve("stem-runtime/python.exe", BaseDirectory::Resource)
        .map_err(|error| format!("Could not locate the bundled Python runtime: {error}"))?;
    let runtime = app
        .path()
        .resolve("stem-runtime/Lib/site-packages", BaseDirectory::Resource)
        .map_err(|error| format!("Could not locate the bundled stem packages: {error}"))?;
    if !python.is_file() || !runtime.join("onnxruntime").is_dir() {
        return Err(
            "The bundled CPU/GPU stem runtime is missing. Rebuild or reinstall Drop Theory Pro."
                .to_string(),
        );
    }
    let python = fs::canonicalize(python)
        .map_err(|error| format!("Could not open the bundled Python runtime: {error}"))?;
    let runtime = fs::canonicalize(runtime)
        .map_err(|error| format!("Could not open the bundled stem packages: {error}"))?;
    Ok((python, runtime))
}

fn bundled_stem_models(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let manifest = match app
        .path()
        .resolve("stem-models/bundle-manifest.json", BaseDirectory::Resource)
    {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if !manifest.is_file() {
        return Ok(None);
    }
    let directory = manifest
        .parent()
        .ok_or_else(|| "Could not locate the bundled stem models.".to_string())?;
    let directory = fs::canonicalize(directory)
        .map_err(|error| format!("Could not open the bundled stem models: {error}"))?;
    Ok(Some(directory))
}

fn model_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?;
    let cache = data_dir.join("stem-model-cache");
    fs::create_dir_all(&cache)
        .map_err(|error| format!("Could not create the local model cache: {error}"))?;
    Ok(cache)
}

fn separation_cache_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("stems")
}

fn catalog_cache_key(track: &Path, model_choice: &str, overlap: f64) -> Result<String, String> {
    let metadata =
        fs::metadata(track).map_err(|error| format!("Could not inspect local audio: {error}"))?;
    let modified = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = DefaultHasher::new();
    track.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    model_choice.hash(&mut hasher);
    overlap.to_bits().hash(&mut hasher);
    UVR_SEPARATOR_VERSION.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

#[cfg(test)]
fn load_manifest(location: &str) -> Result<(PathBuf, StemManifest, PathBuf), String> {
    let root = fs::canonicalize(location)
        .map_err(|error| format!("Could not open the selected model folder: {error}"))?;
    if !root.is_dir() {
        return Err("The selected model location must be a folder.".to_string());
    }
    let manifest_path = root.join("crateforge-stem-model.json");
    let serialized = fs::read_to_string(&manifest_path).map_err(|error| {
        format!("Model folder must contain crateforge-stem-model.json: {error}")
    })?;
    let manifest: StemManifest = serde_json::from_str(&serialized)
        .map_err(|error| format!("The model manifest is invalid: {error}"))?;
    if manifest.format != "crateforge-onnx-stems" || manifest.version != 1 {
        return Err("This model manifest format or version is not supported.".to_string());
    }
    if manifest.model_id.trim().is_empty() || manifest.model_id.len() > 120 {
        return Err("The model manifest must include a short model identifier.".to_string());
    }
    if !LICENSES.contains(&manifest.model_license.as_str())
        || !LICENSES.contains(&manifest.weights_license.as_str())
    {
        return Err(format!(
            "The model and weights must use a supported permissive SPDX license: {}.",
            LICENSES.join(", ")
        ));
    }
    for (label, license_file) in [
        ("model", &manifest.model_license_file),
        ("weights", &manifest.weights_license_file),
    ] {
        let path = fs::canonicalize(root.join(license_file))
            .map_err(|error| format!("Could not open the {label} license notice: {error}"))?;
        if !path.starts_with(&root) || !path.is_file() {
            return Err(format!(
                "The {label} license notice must be a file inside the selected model folder."
            ));
        }
    }
    if manifest.sample_rate != 44_100 || manifest.channels != 2 {
        return Err("Drop Theory Pro currently requires a 44.1 kHz stereo ONNX model.".to_string());
    }
    if !(16_384..=1_048_576).contains(&manifest.chunk_samples) {
        return Err("Model chunkSamples must be between 16,384 and 1,048,576.".to_string());
    }
    let output_names = [
        &manifest.output_names.vocals,
        &manifest.output_names.drums,
        &manifest.output_names.bass,
        &manifest.output_names.other,
    ];
    if manifest.input_name.trim().is_empty()
        || output_names.iter().any(|name| name.trim().is_empty())
        || output_names
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != 4
    {
        return Err("The model manifest must name four distinct output tensors.".to_string());
    }
    let model_file = fs::canonicalize(root.join(&manifest.model_file))
        .map_err(|error| format!("Could not open the model file: {error}"))?;
    if !model_file.starts_with(&root) || !model_file.is_file() {
        return Err("The ONNX model file must be inside the selected model folder.".to_string());
    }
    if !model_file
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("onnx"))
    {
        return Err("The model file must use the .onnx format.".to_string());
    }
    Ok((root, manifest, model_file))
}

fn cache_has_stems(directory: &Path) -> bool {
    STEMS.iter().all(|name| {
        fs::metadata(directory.join(format!("{name}.wav")))
            .map(|metadata| metadata.is_file() && metadata.len() > 44)
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cache_has_stems, catalog_cache_key, copy_selected_stems, load_manifest,
        resolve_model_choice, resolve_uvr_overlap, safe_export_name, separation_cache_root,
        spawn_with_stdin, TemporaryDirectory,
    };
    use std::{collections::HashMap, fs, io::Read, path::PathBuf, process::Command};

    const STDIN_CHILD_TEST_ENV: &str = "CRATEFORGE_STEM_STDIN_CHILD_TEST";

    #[test]
    fn stdin_child_harness() {
        if std::env::var_os(STDIN_CHILD_TEST_ENV).is_none() {
            return;
        }
        let mut source = String::new();
        std::io::stdin()
            .read_to_string(&mut source)
            .expect("read source from stdin");
        assert_eq!(source, "runner source sent through stdin");
    }

    #[test]
    fn sends_runner_source_over_stdin_instead_of_command_arguments() {
        let executable = std::env::current_exe().expect("locate test executable");
        let mut command = Command::new(executable);
        command
            .args(["stdin_child_harness", "--nocapture"])
            .env(STDIN_CHILD_TEST_ENV, "1");
        let output = spawn_with_stdin(&mut command, b"runner source sent through stdin")
            .expect("start child test process")
            .wait_with_output()
            .expect("wait for child test process");
        assert!(
            output.status.success(),
            "child test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn only_the_uvr_hq5_separator_is_available() {
        assert_eq!(resolve_model_choice("uvr-mdx-inst-hq-5"), Ok(()));
        assert!(resolve_model_choice("htdemucs-ft").is_err());
        assert!(resolve_model_choice("unknown").is_err());
    }

    #[test]
    fn model_and_overlap_are_part_of_the_stem_cache_key() {
        let root = temporary_folder("profile-cache-key");
        let track = root.join("track.wav");
        fs::write(&track, b"audio fixture").expect("write audio fixture");
        let lower_overlap =
            catalog_cache_key(&track, "uvr-mdx-inst-hq-5", 0.25).expect("cache key");
        let higher_overlap =
            catalog_cache_key(&track, "uvr-mdx-inst-hq-5", 0.75).expect("cache key");
        let repeated =
            catalog_cache_key(&track, "uvr-mdx-inst-hq-5", 0.25).expect("repeated cache key");
        assert_ne!(lower_overlap, higher_overlap);
        assert_eq!(lower_overlap, repeated);
        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn only_official_uvr_overlap_values_are_accepted() {
        assert_eq!(resolve_uvr_overlap(0.25), Ok(0.25));
        assert_eq!(resolve_uvr_overlap(0.99), Ok(0.99));
        assert!(resolve_uvr_overlap(0.5).is_ok());
        assert!(resolve_uvr_overlap(0.4).is_err());
        assert!(resolve_uvr_overlap(f64::NAN).is_err());
    }

    #[test]
    fn rejects_manifest_paths_that_escape_the_model_folder() {
        let root = temporary_folder("manifest-path");
        fs::write(
            root.join("crateforge-stem-model.json"),
            r#"{"format":"crateforge-onnx-stems","version":1,"modelId":"test","modelLicense":"MIT","weightsLicense":"MIT","modelLicenseFile":"LICENSE-MODEL.txt","weightsLicenseFile":"LICENSE-WEIGHTS.txt","modelFile":"../outside.onnx","sampleRate":44100,"channels":2,"chunkSamples":16384,"inputName":"mix","outputNames":{"vocals":"v","drums":"d","bass":"b","other":"o"}}"#,
        )
        .expect("write test manifest");
        assert!(load_manifest(root.to_str().expect("folder path")).is_err());
        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn accepts_a_compatible_manifest_with_local_license_notices() {
        let root = temporary_folder("valid-manifest");
        fs::write(root.join("LICENSE-MODEL.txt"), "MIT").expect("write model notice");
        fs::write(root.join("LICENSE-WEIGHTS.txt"), "MIT").expect("write weights notice");
        fs::write(root.join("model.onnx"), b"model graph placeholder").expect("write model file");
        fs::write(
            root.join("crateforge-stem-model.json"),
            r#"{"format":"crateforge-onnx-stems","version":1,"modelId":"test-four-stem","modelLicense":"MIT","weightsLicense":"Apache-2.0","modelLicenseFile":"LICENSE-MODEL.txt","weightsLicenseFile":"LICENSE-WEIGHTS.txt","modelFile":"model.onnx","sampleRate":44100,"channels":2,"chunkSamples":16384,"inputName":"mix","outputNames":{"vocals":"v","drums":"d","bass":"b","other":"o"}}"#,
        )
        .expect("write test manifest");
        let (_, manifest, _) =
            load_manifest(root.to_str().expect("folder path")).expect("accept local model");
        assert_eq!(manifest.model_id, "test-four-stem");
        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn cache_requires_both_nonempty_uvr_wav_files() {
        let root = temporary_folder("cache-check");
        assert!(!cache_has_stems(&root));
        fs::write(root.join("vocals.wav"), vec![0_u8; 64]).expect("write vocals stem");
        assert!(!cache_has_stems(&root));
        for name in ["instrumental"] {
            fs::write(root.join(format!("{name}.wav")), vec![0_u8; 64]).expect("write stem");
        }
        assert!(cache_has_stems(&root));
        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn selected_stems_export_to_a_unique_folder_with_only_checked_files() {
        let root = temporary_folder("stem-export");
        let app_data = root.join("app-data");
        let cache = separation_cache_root(&app_data);
        let cache_track = cache.join("track");
        let output = root.join("output");
        fs::create_dir_all(&cache_track).expect("create cache folder");
        fs::create_dir_all(&output).expect("create output folder");
        let mut stem_paths = HashMap::new();
        for stem in ["vocals", "instrumental"] {
            let path = cache_track.join(format!("{stem}.wav"));
            fs::write(&path, vec![stem.as_bytes()[0]; 64]).expect("write test stem");
            stem_paths.insert(stem.to_string(), path.to_string_lossy().into_owned());
        }

        let selected = vec!["vocals".to_string(), "instrumental".to_string()];
        let first = PathBuf::from(
            copy_selected_stems(&cache, &stem_paths, &selected, &output, "Live: set")
                .expect("export selected stems"),
        );
        assert!(first.join("vocals.wav").is_file());
        assert!(first.join("instrumental.wav").is_file());

        let second = PathBuf::from(
            copy_selected_stems(&cache, &stem_paths, &selected, &output, "Live: set")
                .expect("export again without overwriting"),
        );
        assert_ne!(first, second);
        assert!(second.ends_with("Live- set - Stems (2)"));
        assert_eq!(safe_export_name("..."), "Track");
        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn stem_export_rejects_files_outside_the_separation_cache() {
        let root = temporary_folder("stem-export-boundary");
        let cache = root.join("cache");
        let cache_track = cache.join("track");
        let outside = root.join("outside");
        let output = root.join("output");
        fs::create_dir_all(&cache_track).expect("create cache folder");
        fs::create_dir_all(&outside).expect("create outside folder");
        fs::create_dir_all(&output).expect("create output folder");
        for stem in ["vocals", "instrumental"] {
            fs::write(cache_track.join(format!("{stem}.wav")), vec![0_u8; 64])
                .expect("write cache stem");
        }
        let outside_vocals = outside.join("vocals.wav");
        fs::write(&outside_vocals, vec![1_u8; 64]).expect("write outside stem");
        let mut stem_paths = HashMap::new();
        stem_paths.insert(
            "vocals".to_string(),
            outside_vocals.to_string_lossy().into_owned(),
        );

        assert!(copy_selected_stems(
            &cache,
            &stem_paths,
            &["vocals".to_string()],
            &output,
            "Track",
        )
        .is_err());
        assert!(!output.join("Track - Stems").exists());
        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn temporary_directory_guard_cleans_up_on_failure() {
        let root = temporary_folder("guard-cleanup");
        let temporary = root.join("work");
        fs::create_dir_all(&temporary).expect("create temporary directory");
        {
            let _guard = TemporaryDirectory::new(temporary.clone());
        }
        assert!(!temporary.exists());
        fs::remove_dir_all(root).expect("remove test folder");
    }

    #[test]
    fn disarmed_temporary_directory_keeps_renamed_cache() {
        let root = temporary_folder("guard-disarm");
        let temporary = root.join("work");
        let cached = root.join("cached");
        fs::create_dir_all(&temporary).expect("create temporary directory");
        let guard = TemporaryDirectory::new(temporary.clone());
        fs::rename(&temporary, &cached).expect("rename into cache");
        guard.disarm();
        assert!(cached.exists());
        fs::remove_dir_all(root).expect("remove test folder");
    }

    fn temporary_folder(prefix: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("crateforge-{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create test folder");
        path
    }
}
