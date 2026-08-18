use crate::domain::{AppConfig, Project, ProjectMetadataUpdateInput, CURRENT_SCHEMA_VERSION};
use crate::error::CommandError;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const MAX_PROJECT_GROUP_CHARS: usize = 40;

pub struct ConfigStore {
    path: PathBuf,
    value: Mutex<AppConfig>,
}

impl ConfigStore {
    pub fn open(path: PathBuf) -> Result<Self, CommandError> {
        let value = load_config(&path)?;
        Ok(Self {
            path,
            value: Mutex::new(value),
        })
    }

    pub fn projects(&self) -> Result<Vec<Project>, CommandError> {
        let config = self
            .value
            .lock()
            .map_err(|_| CommandError::new("config_lock_failed", "配置存储暂时不可用"))?;
        Ok(config.projects.clone())
    }

    pub fn add_project(&self, mut project: Project) -> Result<Project, CommandError> {
        let mut config = self
            .value
            .lock()
            .map_err(|_| CommandError::new("config_lock_failed", "配置存储暂时不可用"))?;

        if let Some(existing) = config.projects.iter().find(|item| item.id == project.id) {
            project.favorite = existing.favorite;
            project.group.clone_from(&existing.group);
        }

        let mut next = config.clone();
        next.projects.retain(|existing| existing.id != project.id);
        next.projects.insert(0, project.clone());
        write_config(&self.path, &next)?;
        *config = next;
        Ok(project)
    }

    pub fn remove_project(&self, id: &str) -> Result<(), CommandError> {
        let mut config = self
            .value
            .lock()
            .map_err(|_| CommandError::new("config_lock_failed", "配置存储暂时不可用"))?;
        let mut next = config.clone();
        let previous_len = next.projects.len();
        next.projects.retain(|project| project.id != id);
        if next.projects.len() == previous_len {
            return Err(CommandError::new(
                "project_not_found",
                "项目不存在，请刷新后重试",
            ));
        }
        write_config(&self.path, &next)?;
        *config = next;
        Ok(())
    }

    pub fn update_project_metadata(
        &self,
        input: ProjectMetadataUpdateInput,
    ) -> Result<Project, CommandError> {
        let group = normalize_group(input.group)?;
        let mut config = self
            .value
            .lock()
            .map_err(|_| CommandError::new("config_lock_failed", "配置存储暂时不可用"))?;
        let mut next = config.clone();
        let project = next
            .projects
            .iter_mut()
            .find(|project| project.id == input.id)
            .ok_or_else(|| CommandError::new("project_not_found", "项目不存在，请刷新后重试"))?;
        project.favorite = input.favorite;
        project.group = group;
        let updated = project.clone();
        write_config(&self.path, &next)?;
        *config = next;
        Ok(updated)
    }
}

fn normalize_group(group: Option<String>) -> Result<Option<String>, CommandError> {
    let Some(group) = group else {
        return Ok(None);
    };
    let group = group.trim();
    if group.is_empty() {
        return Ok(None);
    }
    if group.chars().count() > MAX_PROJECT_GROUP_CHARS || group.chars().any(char::is_control) {
        return Err(CommandError::new(
            "invalid_project_group",
            format!("项目分组不能包含控制字符，且最多 {MAX_PROJECT_GROUP_CHARS} 个字符"),
        ));
    }
    Ok(Some(group.to_owned()))
}

fn load_config(path: &Path) -> Result<AppConfig, CommandError> {
    let backup_path = backup_path(path);
    if !path.try_exists()? {
        if !backup_path.try_exists()? {
            return Ok(AppConfig::default());
        }
        return match recover_config_from_backup(path, &backup_path) {
            Ok(config) => Ok(config),
            Err(error) if is_corrupt_config_error(&error) => {
                reset_corrupt_config(path, &[&backup_path])
            }
            Err(error) => Err(error),
        };
    }

    match read_normalized_config(path) {
        Ok((config, migrated)) => {
            if migrated {
                write_config(path, &config)?;
            }
            Ok(config)
        }
        Err(primary_error) => {
            if !backup_path.try_exists()? {
                return if is_corrupt_config_error(&primary_error) {
                    reset_corrupt_config(path, &[path])
                } else {
                    Err(primary_error)
                };
            }
            match recover_config_from_backup(path, &backup_path) {
                Ok(config) => Ok(config),
                Err(backup_error)
                    if is_corrupt_config_error(&primary_error)
                        && is_corrupt_config_error(&backup_error) =>
                {
                    reset_corrupt_config(path, &[path, &backup_path])
                }
                Err(backup_error) if is_corrupt_config_error(&primary_error) => Err(backup_error),
                Err(_) => Err(primary_error),
            }
        }
    }
}

fn is_corrupt_config_error(error: &CommandError) -> bool {
    error.code == "invalid_config"
}

fn reset_corrupt_config(path: &Path, corrupt_paths: &[&Path]) -> Result<AppConfig, CommandError> {
    for corrupt_path in corrupt_paths {
        quarantine_corrupt_file(corrupt_path)?;
    }
    let config = AppConfig::default();
    replace_config_without_backup(path, &config)?;
    Ok(config)
}

fn quarantine_corrupt_file(path: &Path) -> Result<PathBuf, CommandError> {
    let quarantine_path = unique_corrupt_path(path);
    fs::rename(path, &quarantine_path)?;
    Ok(quarantine_path)
}

fn recover_config_from_backup(path: &Path, backup_path: &Path) -> Result<AppConfig, CommandError> {
    let (recovered, _) = read_normalized_config(backup_path)?;
    // Recovery must not call write_config: rotating an incompatible or corrupt
    // primary into .bak would destroy the compatible backup we just validated.
    replace_config_without_backup(path, &recovered)?;
    Ok(recovered)
}

fn read_normalized_config(path: &Path) -> Result<(AppConfig, bool), CommandError> {
    normalize_schema(read_config(path)?)
}

fn read_config(path: &Path) -> Result<AppConfig, CommandError> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(CommandError::from)
}

fn normalize_schema(mut config: AppConfig) -> Result<(AppConfig, bool), CommandError> {
    match config.schema_version {
        CURRENT_SCHEMA_VERSION => Ok((config, false)),
        1 => {
            config.schema_version = CURRENT_SCHEMA_VERSION;
            Ok((config, true))
        }
        version => Err(CommandError::new(
            "unsupported_config_version",
            format!("配置版本 {version} 暂不受支持，当前版本为 {CURRENT_SCHEMA_VERSION}"),
        )),
    }
}

fn write_config(path: &Path, config: &AppConfig) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut bytes = serde_json::to_vec_pretty(config)?;
    bytes.push(b'\n');
    let temporary_path = unique_temporary_path(path, "write");
    create_synced_file(&temporary_path, &bytes)?;

    let result = (|| -> std::io::Result<()> {
        if path.try_exists()? {
            copy_file_atomically(path, &backup_path(path))?;
        }
        replace_file(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result.map_err(CommandError::from)
}

fn replace_config_without_backup(path: &Path, config: &AppConfig) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut bytes = serde_json::to_vec_pretty(config)?;
    bytes.push(b'\n');
    let temporary_path = unique_temporary_path(path, "recovery");
    create_synced_file(&temporary_path, &bytes)?;
    let result = replace_file(&temporary_path, path);
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result.map_err(CommandError::from)
}

fn create_synced_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn copy_file_atomically(source: &Path, destination: &Path) -> std::io::Result<()> {
    let temporary_path = unique_temporary_path(destination, "backup");
    let result = (|| -> std::io::Result<()> {
        let mut source_file = File::open(source)?;
        let mut temporary_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        io::copy(&mut source_file, &mut temporary_file)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        replace_file(&temporary_path, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn unique_temporary_path(path: &Path, purpose: &str) -> PathBuf {
    let mut file_name = path
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("config"));
    file_name.push(format!(
        ".{purpose}.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ));
    path.with_file_name(file_name)
}

fn unique_corrupt_path(path: &Path) -> PathBuf {
    let mut file_name = path
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("config"));
    file_name.push(format!(".corrupt-{}", Uuid::new_v4()));
    path.with_file_name(file_name)
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn project(name: &str) -> Project {
        Project {
            id: name.to_owned(),
            name: name.to_owned(),
            path: format!("/tmp/{name}"),
            added_at: 1,
            favorite: false,
            group: None,
        }
    }

    fn quarantined_files(directory: &Path, original_name: &str) -> Vec<PathBuf> {
        let prefix = format!("{original_name}.corrupt-");
        let mut paths = fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    #[test]
    fn temporary_paths_are_unique_and_stay_next_to_the_config() {
        let path = Path::new("/tmp/git-knot/config.json");
        let first = unique_temporary_path(path, "write");
        let second = unique_temporary_path(path, "write");

        assert_ne!(first, second);
        assert_eq!(first.parent(), path.parent());
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("config.json.write."));
        assert!(first
            .extension()
            .is_some_and(|extension| extension == "tmp"));
    }

    #[test]
    fn concurrent_writes_keep_primary_and_backup_as_complete_json() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        write_config(
            &path,
            &AppConfig {
                schema_version: CURRENT_SCHEMA_VERSION,
                projects: vec![project("initial")],
            },
        )
        .unwrap();

        let writers = 8;
        let barrier = Arc::new(Barrier::new(writers));
        let handles = (0..writers)
            .map(|index| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let name = format!("writer-{index}");
                    let config = AppConfig {
                        schema_version: CURRENT_SCHEMA_VERSION,
                        projects: vec![project(&name)],
                    };
                    barrier.wait();
                    for _ in 0..8 {
                        write_config(&path, &config).unwrap();
                    }
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(read_config(&path).unwrap().projects.len(), 1);
        assert_eq!(read_config(&backup_path(&path)).unwrap().projects.len(), 1);
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    #[test]
    fn persists_projects_and_keeps_most_recent_first() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let store = ConfigStore::open(path.clone()).unwrap();
        store.add_project(project("one")).unwrap();
        store.add_project(project("two")).unwrap();

        let reopened = ConfigStore::open(path).unwrap();
        let names = reopened
            .projects()
            .unwrap()
            .into_iter()
            .map(|item| item.name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["two", "one"]);
    }

    #[test]
    fn removes_only_the_selected_project_and_persists_the_change() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let store = ConfigStore::open(path.clone()).unwrap();
        store.add_project(project("one")).unwrap();
        store.add_project(project("two")).unwrap();

        store.remove_project("one").unwrap();
        assert_eq!(
            store
                .projects()
                .unwrap()
                .into_iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec!["two"]
        );

        let reopened = ConfigStore::open(path).unwrap();
        assert_eq!(reopened.projects().unwrap()[0].id, "two");
        assert_eq!(
            store.remove_project("missing").unwrap_err().code,
            "project_not_found"
        );
    }

    #[test]
    fn updates_project_metadata_and_preserves_it_when_readding() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let store = ConfigStore::open(path.clone()).unwrap();
        store.add_project(project("one")).unwrap();
        store
            .update_project_metadata(ProjectMetadataUpdateInput {
                id: "one".to_owned(),
                favorite: true,
                group: Some("  客户项目  ".to_owned()),
            })
            .unwrap();

        let readded = store.add_project(project("one")).unwrap();
        assert!(readded.favorite);
        assert_eq!(readded.group.as_deref(), Some("客户项目"));

        let reopened = ConfigStore::open(path).unwrap();
        let saved = &reopened.projects().unwrap()[0];
        assert!(saved.favorite);
        assert_eq!(saved.group.as_deref(), Some("客户项目"));
    }

    #[test]
    fn clears_empty_groups_and_rejects_invalid_groups() {
        let directory = tempdir().unwrap();
        let store = ConfigStore::open(directory.path().join("config.json")).unwrap();
        store.add_project(project("one")).unwrap();

        let cleared = store
            .update_project_metadata(ProjectMetadataUpdateInput {
                id: "one".to_owned(),
                favorite: false,
                group: Some("   ".to_owned()),
            })
            .unwrap();
        assert_eq!(cleared.group, None);

        let error = store
            .update_project_metadata(ProjectMetadataUpdateInput {
                id: "one".to_owned(),
                favorite: false,
                group: Some("a".repeat(MAX_PROJECT_GROUP_CHARS + 1)),
            })
            .unwrap_err();
        assert_eq!(error.code, "invalid_project_group");
    }

    #[test]
    fn migrates_schema_one_projects_with_default_metadata() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(
            &path,
            br#"{
  "schemaVersion": 1,
  "projects": [
    {"id": "one", "name": "one", "path": "/tmp/one", "addedAt": 1}
  ]
}
"#,
        )
        .unwrap();

        let store = ConfigStore::open(path.clone()).unwrap();
        let saved = &store.projects().unwrap()[0];
        assert!(!saved.favorite);
        assert_eq!(saved.group, None);

        let migrated: AppConfig = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(migrated.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn recovers_compatible_backup_when_primary_schema_is_newer() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let backup = backup_path(&path);
        let future_version = CURRENT_SCHEMA_VERSION + 1;
        fs::write(
            &path,
            format!(
                r#"{{"schemaVersion":{future_version},"projects":[{{"id":"future","name":"future","path":"/tmp/future","addedAt":1}}]}}"#
            ),
        )
        .unwrap();
        let compatible = AppConfig {
            schema_version: CURRENT_SCHEMA_VERSION,
            projects: vec![project("compatible")],
        };
        fs::write(&backup, serde_json::to_vec_pretty(&compatible).unwrap()).unwrap();

        let recovered = ConfigStore::open(path.clone()).unwrap();

        assert_eq!(recovered.projects().unwrap()[0].id, "compatible");
        let restored: AppConfig = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(restored.projects[0].id, "compatible");
        let preserved_backup: AppConfig =
            serde_json::from_slice(&fs::read(&backup).unwrap()).unwrap();
        assert_eq!(preserved_backup.projects[0].id, "compatible");
    }

    #[test]
    fn newer_primary_without_compatible_backup_keeps_stable_error() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let future_version = CURRENT_SCHEMA_VERSION + 1;
        fs::write(
            &path,
            format!(r#"{{"schemaVersion":{future_version},"projects":[]}}"#),
        )
        .unwrap();

        let error = ConfigStore::open(path)
            .err()
            .expect("newer config without backup must fail");
        assert_eq!(error.code, "unsupported_config_version");
    }

    #[test]
    fn newer_primary_with_corrupt_backup_keeps_stable_error() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let backup = backup_path(&path);
        let future_version = CURRENT_SCHEMA_VERSION + 1;
        let primary = format!(r#"{{"schemaVersion":{future_version},"projects":[]}}"#);
        fs::write(&path, &primary).unwrap();
        fs::write(&backup, b"not-json").unwrap();

        let error = ConfigStore::open(path.clone())
            .err()
            .expect("newer config must not be discarded when its backup is corrupt");

        assert_eq!(error.code, "unsupported_config_version");
        assert_eq!(fs::read_to_string(path).unwrap(), primary);
        assert_eq!(fs::read(backup).unwrap(), b"not-json");
        assert!(quarantined_files(directory.path(), "config.json").is_empty());
        assert!(quarantined_files(directory.path(), "config.json.bak").is_empty());
    }

    #[test]
    fn corrupt_primary_without_backup_starts_with_default_and_is_preserved() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let corrupt_bytes = b"not-json";
        fs::write(&path, corrupt_bytes).unwrap();

        let store = ConfigStore::open(path.clone()).unwrap();

        assert!(store.projects().unwrap().is_empty());
        let restored = read_config(&path).unwrap();
        assert_eq!(restored.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(restored.projects.is_empty());
        let quarantined = quarantined_files(directory.path(), "config.json");
        assert_eq!(quarantined.len(), 1);
        assert_eq!(fs::read(&quarantined[0]).unwrap(), corrupt_bytes);
    }

    #[test]
    fn corrupt_primary_and_backup_start_with_default_and_are_preserved() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let backup = backup_path(&path);
        fs::write(&path, b"broken-primary").unwrap();
        fs::write(&backup, b"broken-backup").unwrap();

        let store = ConfigStore::open(path.clone()).unwrap();

        assert!(store.projects().unwrap().is_empty());
        assert!(read_config(&path).unwrap().projects.is_empty());
        assert!(!backup.exists());
        let primary_quarantine = quarantined_files(directory.path(), "config.json");
        let backup_quarantine = quarantined_files(directory.path(), "config.json.bak");
        assert_eq!(primary_quarantine.len(), 1);
        assert_eq!(backup_quarantine.len(), 1);
        assert_eq!(fs::read(&primary_quarantine[0]).unwrap(), b"broken-primary");
        assert_eq!(fs::read(&backup_quarantine[0]).unwrap(), b"broken-backup");
    }

    #[test]
    fn recovers_from_backup_when_primary_is_missing() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let store = ConfigStore::open(path.clone()).unwrap();
        store.add_project(project("one")).unwrap();
        store.add_project(project("two")).unwrap();
        fs::remove_file(&path).unwrap();

        let recovered = ConfigStore::open(path.clone()).unwrap();

        assert_eq!(recovered.projects().unwrap()[0].name, "one");
        assert!(path.exists());
        let restored: AppConfig = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(restored.projects[0].name, "one");
    }

    #[test]
    fn recovers_from_backup_when_primary_is_corrupted() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        let store = ConfigStore::open(path.clone()).unwrap();
        store.add_project(project("one")).unwrap();
        store.add_project(project("two")).unwrap();
        fs::write(&path, b"not-json").unwrap();

        let recovered = ConfigStore::open(path).unwrap();
        assert_eq!(recovered.projects().unwrap()[0].name, "one");
    }
}
