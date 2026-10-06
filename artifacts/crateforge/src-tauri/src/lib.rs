use std::fs;
use std::path::Path;

use chrono::Utc;
use lofty::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const STATE_KEY: &str = "library";
const MUSIC_FOLDER_KEY: &str = "music_folder";
const MIDI_BINDINGS_KEY: &str = "midi_bindings";
pub(crate) const AUDIO_OUTPUT_KEY: &str = "audio_output";

fn database(app: &AppHandle) -> Result<Connection, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?;
    fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("Could not create Drop Theory Pro app data: {error}"))?;

    let connection = Connection::open(app_data_dir.join("crateforge.sqlite3"))
        .map_err(|error| format!("Could not open the local library database: {error}"))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("Could not initialize the local library database: {error}"))?;
    Ok(connection)
}

pub(crate) fn load_audio_output_preference(
    app: &AppHandle,
) -> Result<Option<(String, String)>, String> {
    let connection = database(app)?;
    let serialized = connection
        .query_row(
            "SELECT value FROM local_settings WHERE key = ?1",
            params![AUDIO_OUTPUT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the saved audio output: {error}"))?;
    let Some(serialized) = serialized else {
        return Ok(None);
    };
    let preference: Value = serde_json::from_str(&serialized)
        .map_err(|error| format!("The saved audio output is invalid: {error}"))?;
    let id = preference
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The saved audio output has no device identity.".to_string())?;
    let name = preference
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The saved audio output has no device name.".to_string())?;
    Ok(Some((id.to_string(), name.to_string())))
}

pub(crate) fn save_audio_output_preference(
    app: &AppHandle,
    id: &str,
    name: &str,
) -> Result<(), String> {
    let connection = database(app)?;
    let serialized = serde_json::to_string(&json!({ "id": id, "name": name }))
        .map_err(|error| format!("Could not encode the audio output: {error}"))?;
    connection
        .execute(
            "INSERT INTO local_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![AUDIO_OUTPUT_KEY, serialized],
        )
        .map_err(|error| format!("Could not save the audio output: {error}"))?;
    Ok(())
}

fn music_extensions() -> [&'static str; 9] {
    [
        "mp3", "flac", "wav", "aif", "aiff", "m4a", "mp4", "ogg", "opus",
    ]
}

fn is_supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| music_extensions().contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn filename_artist_title(path: &Path) -> (String, String) {
    let name = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().trim().to_string())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "Untitled track".to_string());
    match name.split_once(" - ") {
        Some((artist, title)) if !artist.trim().is_empty() && !title.trim().is_empty() => {
            (artist.trim().to_string(), title.trim().to_string())
        }
        _ => (String::new(), name),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    tracks: Vec<Value>,
    scanned_files: usize,
    metadata_warnings: usize,
}

#[tauri::command]
fn load_library_state(app: AppHandle) -> Result<Option<Value>, String> {
    let connection = database(&app)?;
    let serialized = connection
        .query_row(
            "SELECT value FROM local_settings WHERE key = ?1",
            params![STATE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the local library: {error}"))?;

    serialized
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| format!("The saved local library is invalid: {error}"))
        })
        .transpose()
}

#[tauri::command]
fn save_library_state(app: AppHandle, state: Value) -> Result<(), String> {
    let connection = database(&app)?;
    let serialized = serde_json::to_string(&state)
        .map_err(|error| format!("Could not encode the local library: {error}"))?;
    connection
        .execute(
            "INSERT INTO local_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![STATE_KEY, serialized],
        )
        .map_err(|error| format!("Could not save the local library: {error}"))?;
    Ok(())
}

#[tauri::command]
fn clear_library_state(app: AppHandle) -> Result<(), String> {
    database(&app)?
        .execute(
            "DELETE FROM local_settings WHERE key = ?1",
            params![STATE_KEY],
        )
        .map_err(|error| format!("Could not clear the local library: {error}"))?;
    Ok(())
}

#[tauri::command]
fn load_midi_bindings(app: AppHandle) -> Result<Vec<Value>, String> {
    let connection = database(&app)?;
    let serialized = connection
        .query_row(
            "SELECT value FROM local_settings WHERE key = ?1",
            params![MIDI_BINDINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Could not read local MIDI mappings: {error}"))?;

    match serialized {
        Some(value) => serde_json::from_str(&value)
            .map_err(|error| format!("The saved MIDI mappings are invalid: {error}")),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
fn save_midi_bindings(app: AppHandle, bindings: Vec<Value>) -> Result<(), String> {
    let connection = database(&app)?;
    let serialized = serde_json::to_string(&bindings)
        .map_err(|error| format!("Could not encode MIDI mappings: {error}"))?;
    connection
        .execute(
            "INSERT INTO local_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![MIDI_BINDINGS_KEY, serialized],
        )
        .map_err(|error| format!("Could not save local MIDI mappings: {error}"))?;
    Ok(())
}

#[tauri::command]
fn get_music_folder(app: AppHandle) -> Result<Option<String>, String> {
    database(&app)?
        .query_row(
            "SELECT value FROM local_settings WHERE key = ?1",
            params![MUSIC_FOLDER_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the selected music folder: {error}"))
}

#[tauri::command]
fn set_music_folder(app: AppHandle, path: String) -> Result<(), String> {
    let folder = fs::canonicalize(&path)
        .map_err(|error| format!("Could not open the selected music folder: {error}"))?;
    if !folder.is_dir() {
        return Err("The selected music folder is not available.".to_string());
    }

    database(&app)?
        .execute(
            "INSERT INTO local_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![MUSIC_FOLDER_KEY, folder.to_string_lossy()],
        )
        .map_err(|error| format!("Could not save the selected music folder: {error}"))?;
    Ok(())
}

#[tauri::command]
fn authorize_track_file(app: AppHandle, path: String) -> Result<String, String> {
    let selected_folder = get_music_folder(app.clone())?
        .ok_or_else(|| "Choose and scan a music folder before playing this file.".to_string())?;
    let root = fs::canonicalize(selected_folder)
        .map_err(|error| format!("The selected music folder is no longer available: {error}"))?;
    let audio_file = fs::canonicalize(&path)
        .map_err(|error| format!("Could not open this local audio file: {error}"))?;

    if !audio_file.is_file() {
        return Err("This local audio file is no longer available.".to_string());
    }
    if !is_supported_audio(&audio_file) {
        return Err("This file format is not supported for playback.".to_string());
    }
    if !audio_file.starts_with(&root) {
        return Err("Playback is limited to files inside the selected music folder.".to_string());
    }

    app.asset_protocol_scope()
        .allow_file(&audio_file)
        .map_err(|error| format!("Could not authorize this local audio file: {error}"))?;
    Ok(audio_file.to_string_lossy().into_owned())
}

fn missing_music_files(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| !Path::new(path).is_file())
        .collect()
}

#[tauri::command]
fn check_music_files(paths: Vec<String>) -> Vec<String> {
    missing_music_files(paths)
}

#[tauri::command]
fn scan_music_folder(path: String) -> Result<ScanResult, String> {
    let root = fs::canonicalize(&path)
        .map_err(|error| format!("Could not open the selected music folder: {error}"))?;
    if !root.is_dir() {
        return Err("The selected music folder is not a directory.".to_string());
    }

    let mut tracks = Vec::new();
    let mut scanned_files = 0;
    let mut metadata_warnings = 0;

    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                metadata_warnings += 1;
                continue;
            }
        };
        let file_path = entry.path();
        if !entry.file_type().is_file() || !is_supported_audio(file_path) {
            continue;
        }
        scanned_files += 1;

        let parsed = lofty::read_from_path(file_path).ok();
        if parsed.is_none() {
            metadata_warnings += 1;
        }
        let (filename_artist, filename_title) = filename_artist_title(file_path);
        let tag = parsed.as_ref().and_then(|tagged_file| {
            tagged_file
                .primary_tag()
                .or_else(|| tagged_file.first_tag())
        });
        let title = tag
            .and_then(|tag| tag.title())
            .map(|value| value.into_owned())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(filename_title);
        let artist = tag
            .and_then(|tag| tag.artist())
            .map(|value| value.into_owned())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(filename_artist);
        let album = tag
            .and_then(|tag| tag.album())
            .map(|value| value.into_owned())
            .unwrap_or_default();
        let genre = tag
            .and_then(|tag| tag.genre())
            .map(|value| value.into_owned())
            .unwrap_or_default();
        let year = tag.and_then(|tag| tag.year()).map(i64::from);
        let duration_seconds = parsed
            .as_ref()
            .map(|tagged_file| tagged_file.properties().duration().as_secs_f64());
        let file_size = fs::metadata(file_path).ok().map(|metadata| metadata.len());
        let file_name = file_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| title.clone());

        tracks.push(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "title": title,
            "artist": artist,
            "album": album,
            "genre": genre,
            "year": year,
            "durationSeconds": duration_seconds,
            "bpm": null,
            "key": null,
            "energy": null,
            "rating": 0,
            "fileName": file_name,
            "filePath": file_path.to_string_lossy(),
            "fileSize": file_size,
            "contentHash": null,
            "source": "audio",
            "analyzed": false,
            "createdAt": Utc::now().to_rfc3339(),
        }));
    }

    Ok(ScanResult {
        tracks,
        scanned_files,
        metadata_warnings,
    })
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(native_audio::NativeAudioEngine::new(app.handle().clone()));
            Ok(())
        })
        .manage(stems::StemJobs::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_library_state,
            save_library_state,
            clear_library_state,
            load_midi_bindings,
            save_midi_bindings,
            get_music_folder,
            set_music_folder,
            check_music_files,
            scan_music_folder,
            authorize_track_file,
            imported_audio::save_imported_audio,
            imported_audio::load_imported_audio,
            imported_audio::list_imported_audio,
            imported_audio::delete_imported_audio,
            native_audio::get_native_audio_outputs,
            native_audio::set_native_audio_output,
            native_audio::get_native_audio_status,
            native_audio::load_native_deck,
            native_audio::load_native_stems,
            native_audio::unload_native_deck,
            native_audio::play_native_deck,
            native_audio::pause_native_deck,
            native_audio::seek_native_deck,
            native_audio::set_native_cue,
            native_audio::return_native_to_cue,
            native_audio::set_native_loop,
            native_audio::set_native_tempo,
            native_audio::set_native_deck_gain,
            native_audio::set_native_deck_eq,
            native_audio::set_native_crossfader,
            native_audio::set_native_master_gain,
            native_audio::set_native_stems_enabled,
            native_audio::set_native_stem_gain,
            stems::load_stem_settings,
            stems::save_stem_settings,
            stems::inspect_stem_model,
            stems::download_stem_model,
            stems::start_stem_separation,
            stems::start_stem_separation_from_audio,
            stems::cancel_stem_separation,
            stems::export_separated_stems,
            song_extension::create_extended_song,
            song_extension::create_extended_song_from_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running Drop Theory Pro");
}

mod imported_audio;
mod native_audio;
mod song_extension;
mod stems;

#[cfg(test)]
mod tests {
    use super::{filename_artist_title, is_supported_audio, missing_music_files};
    use std::{fs, path::Path};

    #[test]
    fn accepts_supported_audio_extensions_case_insensitively() {
        assert!(is_supported_audio(Path::new("D:/Music/Live Set.FLAC")));
        assert!(is_supported_audio(Path::new("/music/track.Mp3")));
        assert!(!is_supported_audio(Path::new("/music/cover.jpg")));
    }

    #[test]
    fn infers_artist_and_title_from_file_name() {
        assert_eq!(
            filename_artist_title(Path::new("Mira Sol - Golden Hour.flac")),
            ("Mira Sol".to_string(), "Golden Hour".to_string())
        );
        assert_eq!(
            filename_artist_title(Path::new("Untitled.wav")),
            (String::new(), "Untitled".to_string())
        );
    }

    #[test]
    fn reports_missing_audio_paths_without_dropping_other_library_records() {
        let present = std::env::temp_dir().join(format!("crateforge-{}.wav", uuid::Uuid::new_v4()));
        fs::write(&present, b"local test").expect("create a temporary local file");
        let missing = present.with_file_name("crateforge-missing-audio.wav");
        let result = missing_music_files(vec![
            present.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ]);
        fs::remove_file(&present).expect("remove temporary local file");
        assert_eq!(result, vec![missing.to_string_lossy().into_owned()]);
    }
}
