use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager};

#[derive(Debug)]
pub(crate) struct TemporaryImportedAudio {
    path: PathBuf,
}

impl TemporaryImportedAudio {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryImportedAudio {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) fn write_imported_audio(
    app: &AppHandle,
    file_name: &str,
    audio_bytes: &[u8],
) -> Result<TemporaryImportedAudio, String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The imported audio file has no supported file extension.".to_string())?;
    let temporary_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?
        .join("imported-audio-temp");

    write_imported_audio_in(&temporary_path, &extension, audio_bytes)
}

#[tauri::command]
pub(crate) fn save_imported_audio(
    app: AppHandle,
    track_id: String,
    file_name: String,
    audio_bytes: Vec<u8>,
) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?
        .join("imported-audio");
    save_imported_audio_in(&directory, &track_id, &file_name, &audio_bytes)
}

#[tauri::command]
pub(crate) fn load_imported_audio(
    app: AppHandle,
    track_ids: Vec<String>,
) -> Result<HashMap<String, Vec<u8>>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?
        .join("imported-audio");
    let mut audio_by_track = HashMap::new();
    for track_id in track_ids {
        if let Some(audio_bytes) = load_imported_audio_in(&directory, &track_id)? {
            audio_by_track.insert(track_id, audio_bytes);
        }
    }
    Ok(audio_by_track)
}

#[tauri::command]
pub(crate) fn list_imported_audio(
    app: AppHandle,
    track_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?
        .join("imported-audio");
    track_ids
        .into_iter()
        .filter_map(
            |track_id| match imported_audio_path_in(&directory, &track_id) {
                Ok(Some(_)) => Some(Ok(track_id)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            },
        )
        .collect()
}

#[tauri::command]
pub(crate) fn delete_imported_audio(app: AppHandle, track_id: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Drop Theory Pro app data: {error}"))?
        .join("imported-audio");
    delete_imported_audio_in(&directory, &track_id)
}

fn track_audio_directory(directory: &Path, track_id: &str) -> Result<PathBuf, String> {
    if track_id.is_empty()
        || !track_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("The imported audio track identity is invalid.".to_string());
    }
    Ok(directory.join(track_id))
}

fn supported_extension(file_name: &str) -> Result<String, String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The imported audio file has no supported file extension.".to_string())?;
    if !super::is_supported_audio(&PathBuf::from(format!("source.{extension}"))) {
        return Err(
            "This audio format is not supported for local stem processing. Use WAV, AIFF, MP3, FLAC, M4A, OGG, or Opus."
                .to_string(),
        );
    }
    Ok(extension)
}

fn save_imported_audio_in(
    directory: &Path,
    track_id: &str,
    file_name: &str,
    audio_bytes: &[u8],
) -> Result<(), String> {
    let track_directory = track_audio_directory(directory, track_id)?;
    let extension = supported_extension(file_name)?;
    if audio_bytes.is_empty() {
        return Err("The imported audio file is empty.".to_string());
    }
    fs::create_dir_all(&track_directory)
        .map_err(|error| format!("Could not prepare local audio storage: {error}"))?;

    let target_path = track_directory.join(format!("source.{extension}"));
    let temporary_path = track_directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| format!("Could not create a local audio file: {error}"))?;
    let result = file
        .write_all(audio_bytes)
        .map_err(|error| format!("Could not copy the imported audio locally: {error}"))
        .and_then(|()| {
            file.flush()
                .map_err(|error| format!("Could not finish copying the imported audio: {error}"))
        })
        .and_then(|()| {
            file.sync_all()
                .map_err(|error| format!("Could not save the imported audio locally: {error}"))
        });
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    if target_path.exists() {
        fs::remove_file(&target_path)
            .map_err(|error| format!("Could not replace the saved audio file: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary_path, &target_path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Could not save the imported audio locally: {error}"
        ));
    }

    for entry in fs::read_dir(&track_directory)
        .map_err(|error| format!("Could not finish saving local audio: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not finish saving local audio: {error}"))?;
        let path = entry.path();
        if path != target_path
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("source."))
        {
            fs::remove_file(path).map_err(|error| {
                format!("Could not replace the previous local audio file: {error}")
            })?;
        }
    }
    Ok(())
}

fn imported_audio_path_in(directory: &Path, track_id: &str) -> Result<Option<PathBuf>, String> {
    let track_directory = track_audio_directory(directory, track_id)?;
    let entries = match fs::read_dir(&track_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read locally saved audio: {error}")),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not read locally saved audio: {error}"))?;
        let file_name = entry.file_name();
        let Some(extension) = file_name
            .to_str()
            .and_then(|name| name.strip_prefix("source."))
        else {
            continue;
        };
        if !super::is_supported_audio(&PathBuf::from(format!("source.{extension}")))
            || !entry
                .file_type()
                .map_err(|error| format!("Could not inspect locally saved audio: {error}"))?
                .is_file()
        {
            continue;
        }
        return Ok(Some(entry.path()));
    }
    Ok(None)
}

fn load_imported_audio_in(directory: &Path, track_id: &str) -> Result<Option<Vec<u8>>, String> {
    imported_audio_path_in(directory, track_id)?
        .map(|path| {
            fs::read(path).map_err(|error| format!("Could not read locally saved audio: {error}"))
        })
        .transpose()
}

fn delete_imported_audio_in(directory: &Path, track_id: &str) -> Result<(), String> {
    let track_directory = track_audio_directory(directory, track_id)?;
    let entries = match fs::read_dir(&track_directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not remove the saved local audio: {error}")),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not remove the saved local audio: {error}"))?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("source."))
        {
            fs::remove_file(entry.path())
                .map_err(|error| format!("Could not remove the saved local audio: {error}"))?;
        }
    }
    let _ = fs::remove_dir(&track_directory);
    Ok(())
}

fn write_imported_audio_in(
    directory: &Path,
    extension: &str,
    audio_bytes: &[u8],
) -> Result<TemporaryImportedAudio, String> {
    let file_name = format!("import-{}.{}", uuid::Uuid::new_v4(), extension);
    let path = directory.join(file_name);
    if !super::is_supported_audio(&path) {
        return Err(
            "This audio format is not supported for local stem processing. Use WAV, AIFF, MP3, FLAC, M4A, OGG, or Opus."
                .to_string(),
        );
    }
    if audio_bytes.is_empty() {
        return Err("The imported audio file is empty.".to_string());
    }
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not prepare temporary local audio storage: {error}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("Could not create a temporary local audio file: {error}"))?;
    let temporary = TemporaryImportedAudio { path };
    let result = file
        .write_all(audio_bytes)
        .map_err(|error| format!("Could not copy the imported audio locally: {error}"))
        .and_then(|()| {
            file.flush()
                .map_err(|error| format!("Could not finish copying the imported audio: {error}"))
        });
    drop(file);
    result?;
    Ok(temporary)
}

#[cfg(test)]
mod tests {
    use super::{
        delete_imported_audio_in, imported_audio_path_in, load_imported_audio_in,
        save_imported_audio_in, write_imported_audio_in,
    };
    use std::{fs, path::PathBuf};

    fn temporary_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "drop-theory-imported-audio-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn imported_audio_is_removed_when_its_temporary_guard_is_dropped() {
        let directory = temporary_directory();
        let path;
        {
            let imported =
                write_imported_audio_in(&directory, "wav", b"local audio").expect("write audio");
            path = imported.path().to_path_buf();
            assert_eq!(
                fs::read(&path).expect("read imported audio"),
                b"local audio"
            );
        }
        assert!(!path.exists());
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn imported_audio_rejects_empty_and_unsupported_files() {
        let directory = temporary_directory();
        assert!(write_imported_audio_in(&directory, "wav", &[]).is_err());
        let error = write_imported_audio_in(&directory, "txt", b"not audio")
            .expect_err("reject unsupported audio");
        assert!(error.contains("not supported"));
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn directly_imported_audio_is_persisted_loaded_and_removed_by_track_id() {
        let directory = temporary_directory();
        let track_id = "track-123";

        save_imported_audio_in(&directory, track_id, "mix.wav", b"saved audio")
            .expect("persist imported audio");
        assert_eq!(
            load_imported_audio_in(&directory, track_id).expect("load imported audio"),
            Some(b"saved audio".to_vec())
        );

        delete_imported_audio_in(&directory, track_id).expect("remove imported audio");
        assert_eq!(
            load_imported_audio_in(&directory, track_id).expect("check removed audio"),
            None
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn imported_audio_can_be_listed_without_reading_file_contents() {
        let directory = temporary_directory();
        let track_id = "track-123";
        save_imported_audio_in(&directory, track_id, "mix.wav", b"saved audio")
            .expect("persist imported audio");

        let path = imported_audio_path_in(&directory, track_id)
            .expect("inspect imported audio")
            .expect("find saved audio");
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("source.wav")
        );
        assert_eq!(imported_audio_path_in(&directory, "missing").unwrap(), None);

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn imported_audio_storage_rejects_invalid_track_ids() {
        let directory = temporary_directory();
        assert!(save_imported_audio_in(&directory, "../outside", "mix.wav", b"audio").is_err());
        assert!(delete_imported_audio_in(&directory, "../outside").is_err());
        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
