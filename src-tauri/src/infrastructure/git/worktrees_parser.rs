use crate::error::CommandError;
use std::collections::{HashMap, HashSet};
use std::path::Path;

const MAX_WORKTREE_PATH_BYTES: usize = 16 * 1024;
const MAX_WORKTREE_REASON_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedWorktree {
    pub path: String,
    pub head_oid: String,
    pub branch_full_name: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub lock_reason: Option<String>,
    pub prunable_reason: Option<String>,
    pub is_main: bool,
}

pub fn parse_worktrees(output: &[u8]) -> Result<Vec<ParsedWorktree>, CommandError> {
    let mut records = Vec::new();
    let mut fields = Vec::new();

    for field in output.split(|byte| *byte == 0) {
        if field.is_empty() {
            if !fields.is_empty() {
                records.push(parse_record(&fields, records.is_empty())?);
                fields.clear();
            }
        } else {
            fields.push(field);
        }
    }
    if !fields.is_empty() {
        records.push(parse_record(&fields, records.is_empty())?);
    }
    if records.is_empty() {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git worktree 列表为空或格式无效",
        ));
    }

    let mut paths = HashSet::new();
    if records.iter().any(|record| !paths.insert(&record.path)) {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git worktree 列表包含重复路径",
        ));
    }
    Ok(records)
}

fn parse_record(fields: &[&[u8]], is_main: bool) -> Result<ParsedWorktree, CommandError> {
    let mut values = HashMap::<&str, &str>::new();
    let mut flags = HashSet::<&str>::new();

    for field in fields {
        let text = std::str::from_utf8(field).map_err(|_| {
            CommandError::new(
                "unsupported_worktree_path_encoding",
                "Git worktree 路径不是有效 UTF-8，当前界面无法安全展示",
            )
        })?;
        let (name, value) = text
            .split_once(' ')
            .map_or((text, None), |(name, value)| (name, Some(value)));
        if name.is_empty() {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git worktree 记录包含空字段名",
            ));
        }
        if let Some(value) = value {
            if values.insert(name, value).is_some() || flags.contains(name) {
                return Err(CommandError::new(
                    "invalid_git_output",
                    "Git worktree 记录包含重复字段",
                ));
            }
        } else if !flags.insert(name) || values.contains_key(name) {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git worktree 记录包含重复标记",
            ));
        }
    }

    let path = values
        .get("worktree")
        .copied()
        .ok_or_else(|| CommandError::new("invalid_git_output", "Git worktree 记录缺少路径"))?;
    if path.is_empty()
        || path.len() > MAX_WORKTREE_PATH_BYTES
        || path.bytes().any(|byte| byte.is_ascii_control())
        || !Path::new(path).is_absolute()
    {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git worktree 记录包含无效绝对路径",
        ));
    }

    let bare = flags.contains("bare");
    let head_oid = values.get("HEAD").copied().unwrap_or_default();
    if !bare && !valid_oid(head_oid) {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git worktree 记录缺少有效 HEAD",
        ));
    }
    if bare && !head_oid.is_empty() && !valid_oid(head_oid) {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git bare worktree 记录包含无效 HEAD",
        ));
    }

    let branch_full_name = values.get("branch").map(|value| (*value).to_owned());
    if branch_full_name.as_deref().is_some_and(|value| {
        !value.starts_with("refs/heads/") || value.len() <= "refs/heads/".len()
    }) {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git worktree 记录包含非本地分支引用",
        ));
    }
    let detached = flags.contains("detached");
    if detached && branch_full_name.is_some() {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git worktree 记录同时包含分离 HEAD 和分支",
        ));
    }

    let lock_reason = marker_reason(&values, &flags, "locked")?;
    let prunable_reason = marker_reason(&values, &flags, "prunable")?;

    Ok(ParsedWorktree {
        path: path.to_owned(),
        head_oid: head_oid.to_owned(),
        branch_full_name,
        detached,
        bare,
        lock_reason,
        prunable_reason,
        is_main,
    })
}

fn marker_reason(
    values: &HashMap<&str, &str>,
    flags: &HashSet<&str>,
    name: &str,
) -> Result<Option<String>, CommandError> {
    let value = values.get(name).copied();
    if value.is_some_and(|reason| reason.len() > MAX_WORKTREE_REASON_BYTES) {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git worktree 状态说明超过允许的读取上限",
        ));
    }
    Ok(value
        .map(str::to_owned)
        .or_else(|| flags.contains(name).then(String::new)))
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_main_detached_locked_and_prunable_records() {
        let main_oid = "a".repeat(40);
        let linked_oid = "b".repeat(40);
        let output = format!(
            "worktree /repo\0HEAD {main_oid}\0branch refs/heads/main\0\0worktree /repo/topic\0HEAD {linked_oid}\0detached\0locked release validation\0prunable gitdir file points to non-existent location\0\0"
        );

        let worktrees = parse_worktrees(output.as_bytes()).unwrap();
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_main);
        assert_eq!(
            worktrees[0].branch_full_name.as_deref(),
            Some("refs/heads/main")
        );
        assert!(!worktrees[0].detached);
        assert!(!worktrees[1].is_main);
        assert!(worktrees[1].detached);
        assert_eq!(
            worktrees[1].lock_reason.as_deref(),
            Some("release validation")
        );
        assert!(worktrees[1].prunable_reason.is_some());
    }

    #[test]
    fn rejects_missing_paths_duplicate_fields_and_non_local_branches() {
        for input in [
            format!("HEAD {}\0branch refs/heads/main\0\0", "a".repeat(40)),
            format!(
                "worktree /repo\0worktree /other\0HEAD {}\0branch refs/heads/main\0\0",
                "a".repeat(40)
            ),
            format!(
                "worktree /repo\0HEAD {}\0branch refs/remotes/origin/main\0\0",
                "a".repeat(40)
            ),
        ] {
            assert_eq!(
                parse_worktrees(input.as_bytes()).unwrap_err().code,
                "invalid_git_output"
            );
        }
    }
}
