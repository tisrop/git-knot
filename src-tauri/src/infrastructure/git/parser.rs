use crate::domain::{BranchStatus, ChangeKind, FileChange, RepositoryStatus};
use crate::error::CommandError;
use std::path::Path;

pub fn parse_status(root: &Path, output: &[u8]) -> Result<RepositoryStatus, CommandError> {
    let records = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut branch = BranchStatus::default();
    let mut changes = Vec::new();
    let mut index = 0;

    while index < records.len() {
        let record = decode_status_record(records[index])?;
        index += 1;
        if record.is_empty() {
            continue;
        }

        if let Some(value) = record.strip_prefix("# branch.oid ") {
            branch.oid = (value != "(initial)").then(|| value.to_owned());
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.head ") {
            branch.head = (value != "(detached)").then(|| value.to_owned());
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.upstream ") {
            branch.upstream = Some(value.to_owned());
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.ab ") {
            for part in value.split_whitespace() {
                if let Some(ahead) = part.strip_prefix('+') {
                    branch.ahead = ahead.parse().unwrap_or(0);
                } else if let Some(behind) = part.strip_prefix('-') {
                    branch.behind = behind.parse().unwrap_or(0);
                }
            }
            continue;
        }

        if record.starts_with("1 ") {
            let fields = record.splitn(9, ' ').collect::<Vec<_>>();
            ensure_field_count(&fields, 9, "普通变更")?;
            let (index_status, worktree_status) = parse_xy(fields[1]);
            changes.push(FileChange {
                path: fields[8].to_owned(),
                original_path: None,
                index_status,
                worktree_status,
                kind: ChangeKind::Ordinary,
            });
            continue;
        }

        if record.starts_with("2 ") {
            let fields = record.splitn(10, ' ').collect::<Vec<_>>();
            ensure_field_count(&fields, 10, "重命名变更")?;
            let original_path = records
                .get(index)
                .filter(|value| !value.is_empty())
                .map(|value| decode_status_record(value).map(str::to_owned))
                .transpose()?
                .ok_or_else(|| {
                    CommandError::new("invalid_git_output", "Git 重命名记录缺少原路径")
                })?;
            index += 1;
            let (index_status, worktree_status) = parse_xy(fields[1]);
            changes.push(FileChange {
                path: fields[9].to_owned(),
                original_path: Some(original_path),
                index_status,
                worktree_status,
                kind: ChangeKind::Renamed,
            });
            continue;
        }

        if record.starts_with("u ") {
            let fields = record.splitn(11, ' ').collect::<Vec<_>>();
            ensure_field_count(&fields, 11, "冲突变更")?;
            let (index_status, worktree_status) = parse_xy(fields[1]);
            changes.push(FileChange {
                path: fields[10].to_owned(),
                original_path: None,
                index_status,
                worktree_status,
                kind: ChangeKind::Unmerged,
            });
            continue;
        }

        if let Some(path) = record.strip_prefix("? ") {
            changes.push(FileChange {
                path: path.to_owned(),
                original_path: None,
                index_status: None,
                worktree_status: None,
                kind: ChangeKind::Untracked,
            });
        }
    }

    Ok(RepositoryStatus {
        root: root.to_string_lossy().into_owned(),
        branch,
        changes,
    })
}

fn decode_status_record(record: &[u8]) -> Result<&str, CommandError> {
    std::str::from_utf8(record).map_err(|_| {
        CommandError::new(
            "unsupported_repository_path_encoding",
            "Git 状态包含非 UTF-8 路径，当前界面无法安全处理",
        )
    })
}

fn ensure_field_count(fields: &[&str], expected: usize, label: &str) -> Result<(), CommandError> {
    if fields.len() == expected {
        Ok(())
    } else {
        Err(CommandError::new(
            "invalid_git_output",
            format!("无法解析 Git {label}记录"),
        ))
    }
}

fn parse_xy(value: &str) -> (Option<String>, Option<String>) {
    let mut chars = value.chars();
    let index = chars
        .next()
        .filter(|value| *value != '.')
        .map(|value| value.to_string());
    let worktree = chars
        .next()
        .filter(|value| *value != '.')
        .map(|value| value.to_string());
    (index, worktree)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_file_records() {
        let input = concat!(
            "# branch.oid abc123\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 M. N... 100644 100644 100644 abc def src/staged file.ts\0",
            "1 .M N... 100644 100644 100644 abc def src/changed.ts\0",
            "2 R. N... 100644 100644 100644 abc def R100 src/new.ts\0src/old.ts\0",
            "? notes/new file.md\0",
        );

        let status = parse_status(Path::new("/repo"), input.as_bytes()).unwrap();
        assert_eq!(status.branch.head.as_deref(), Some("main"));
        assert_eq!(status.branch.ahead, 2);
        assert_eq!(status.branch.behind, 1);
        assert_eq!(status.changes.len(), 4);
        assert_eq!(status.changes[0].path, "src/staged file.ts");
        assert_eq!(
            status.changes[2].original_path.as_deref(),
            Some("src/old.ts")
        );
        assert!(matches!(status.changes[3].kind, ChangeKind::Untracked));
    }

    #[test]
    fn rejects_non_utf8_paths_with_a_stable_error() {
        let ordinary = b"1 .M N... 100644 100644 100644 abc def \xff.txt\0";
        let error = parse_status(Path::new("/repo"), ordinary).unwrap_err();
        assert_eq!(error.code, "unsupported_repository_path_encoding");
        assert_eq!(
            error.message,
            "Git 状态包含非 UTF-8 路径，当前界面无法安全处理"
        );

        let renamed = b"2 R. N... 100644 100644 100644 abc def R100 new.txt\0old-\xff.txt\0";
        let error = parse_status(Path::new("/repo"), renamed).unwrap_err();
        assert_eq!(error.code, "unsupported_repository_path_encoding");
    }

    #[test]
    fn omits_detached_head_and_initial_oid() {
        let input = "# branch.oid (initial)\0# branch.head (detached)\0";
        let status = parse_status(Path::new("/repo"), input.as_bytes()).unwrap();
        assert!(status.branch.oid.is_none());
        assert!(status.branch.head.is_none());
    }
}
