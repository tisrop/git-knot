use crate::error::CommandError;
use std::collections::HashMap;
use std::path::{Component, Path};

const MAX_CONFIG_NAME_BYTES: usize = 1024;
const MAX_CONFIG_VALUE_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedGitlink {
    pub path: String,
    pub oid: String,
    pub stage: u8,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedSubmoduleStatus {
    pub modified: bool,
    pub conflicted: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedSubmoduleConfig {
    pub name: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub branch: Option<String>,
}

pub fn parse_gitlinks(output: &[u8]) -> Result<Vec<ParsedGitlink>, CommandError> {
    let mut gitlinks = Vec::new();
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let (metadata, path) = split_once_byte(record, b'\t').ok_or_else(|| {
            CommandError::new("invalid_git_output", "Git index 记录缺少路径分隔符")
        })?;
        let metadata = std::str::from_utf8(metadata).map_err(|_| {
            CommandError::new("invalid_git_output", "Git index 元数据不是有效 UTF-8")
        })?;
        let fields = metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git index 记录字段数量无效",
            ));
        }
        if fields[0] != "160000" {
            continue;
        }
        let oid = fields[1];
        if !is_oid(oid) {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git submodule index OID 无效",
            ));
        }
        let stage = fields[2].parse::<u8>().map_err(|_| {
            CommandError::new("invalid_git_output", "Git submodule index stage 无效")
        })?;
        if stage > 3 {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git submodule index stage 超出范围",
            ));
        }
        let path = std::str::from_utf8(path).map_err(|_| {
            CommandError::new("invalid_git_output", "Git submodule 路径不是有效 UTF-8")
        })?;
        validate_path(path)?;
        gitlinks.push(ParsedGitlink {
            path: path.to_owned(),
            oid: oid.to_ascii_lowercase(),
            stage,
        });
    }
    Ok(gitlinks)
}

pub fn validate_path(path: &str) -> Result<(), CommandError> {
    let candidate = Path::new(path);
    if path.is_empty()
        || path.len() > 16 * 1024
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git submodule 路径不是安全的仓库相对路径",
        ));
    }
    Ok(())
}

pub fn parse_status(output: &[u8]) -> Result<HashMap<String, ParsedSubmoduleStatus>, CommandError> {
    let records = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut statuses = HashMap::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() || record.starts_with(b"# ") {
            continue;
        }
        let text = std::str::from_utf8(record).map_err(|_| {
            CommandError::new("invalid_git_output", "Git submodule 状态不是有效 UTF-8")
        })?;
        if text.starts_with("1 ") {
            let fields = text.splitn(9, ' ').collect::<Vec<_>>();
            ensure_fields(&fields, 9)?;
            record_status(&mut statuses, fields[8], fields[2], false)?;
        } else if text.starts_with("2 ") {
            let fields = text.splitn(10, ' ').collect::<Vec<_>>();
            ensure_fields(&fields, 10)?;
            record_status(&mut statuses, fields[9], fields[2], false)?;
            if records.get(index).is_none() {
                return Err(CommandError::new(
                    "invalid_git_output",
                    "Git submodule 重命名状态缺少原路径",
                ));
            }
            index += 1;
        } else if text.starts_with("u ") {
            let fields = text.splitn(11, ' ').collect::<Vec<_>>();
            ensure_fields(&fields, 11)?;
            record_status(&mut statuses, fields[10], fields[2], true)?;
        }
    }
    Ok(statuses)
}

pub fn parse_gitmodules(output: &[u8]) -> Result<Vec<ParsedSubmoduleConfig>, CommandError> {
    let mut by_name = HashMap::<String, ParsedSubmoduleConfig>::new();
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let text = std::str::from_utf8(record).map_err(|_| {
            CommandError::new("invalid_gitmodules", ".gitmodules 输出不是有效 UTF-8")
        })?;
        let (key, value) = text
            .split_once('\n')
            .ok_or_else(|| CommandError::new("invalid_gitmodules", ".gitmodules 配置记录缺少值"))?;
        if key.len() > MAX_CONFIG_NAME_BYTES || value.len() > MAX_CONFIG_VALUE_BYTES {
            return Err(CommandError::new(
                "invalid_gitmodules",
                ".gitmodules 配置字段超过允许的读取上限",
            ));
        }
        let rest = key
            .strip_prefix("submodule.")
            .ok_or_else(|| CommandError::new("invalid_gitmodules", ".gitmodules 配置键无效"))?;
        let (name, field) = rest.rsplit_once('.').ok_or_else(|| {
            CommandError::new("invalid_gitmodules", ".gitmodules 配置键缺少字段名")
        })?;
        if name.is_empty()
            || name.bytes().any(|byte| byte.is_ascii_control())
            || value.contains('\0')
        {
            return Err(CommandError::new(
                "invalid_gitmodules",
                ".gitmodules 包含无效名称或控制字符",
            ));
        }
        let item = by_name
            .entry(name.to_owned())
            .or_insert_with(|| ParsedSubmoduleConfig {
                name: name.to_owned(),
                ..ParsedSubmoduleConfig::default()
            });
        let slot = match field {
            "path" => &mut item.path,
            "url" => &mut item.url,
            "branch" => &mut item.branch,
            _ => continue,
        };
        if slot.replace(value.to_owned()).is_some() {
            return Err(CommandError::new(
                "invalid_gitmodules",
                format!("子模块 {name} 的 {field} 配置重复"),
            ));
        }
    }
    let mut values = by_name.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(values)
}

fn record_status(
    statuses: &mut HashMap<String, ParsedSubmoduleStatus>,
    path: &str,
    sub: &str,
    conflicted: bool,
) -> Result<(), CommandError> {
    if sub.len() != 4 || !matches!(sub.as_bytes().first(), Some(b'N' | b'S')) {
        return Err(CommandError::new(
            "invalid_git_output",
            "Git porcelain v2 submodule 字段无效",
        ));
    }
    if !sub.starts_with('S') && !conflicted {
        return Ok(());
    }
    let entry = statuses.entry(path.to_owned()).or_default();
    entry.modified |= sub.as_bytes()[1..].iter().any(|byte| *byte != b'.');
    entry.conflicted |= conflicted;
    Ok(())
}

fn ensure_fields(fields: &[&str], expected: usize) -> Result<(), CommandError> {
    if fields.len() == expected {
        Ok(())
    } else {
        Err(CommandError::new(
            "invalid_git_output",
            "无法解析 Git submodule porcelain v2 状态",
        ))
    }
}

fn split_once_byte(value: &[u8], delimiter: u8) -> Option<(&[u8], &[u8])> {
    let index = value.iter().position(|byte| *byte == delimiter)?;
    Some((&value[..index], &value[index + 1..]))
}

pub fn is_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gitlinks_status_and_gitmodules_records() {
        let oid = "a".repeat(40);
        let gitlinks = parse_gitlinks(
            format!("100644 {oid} 0\tREADME.md\0\n160000 {oid} 0\tdeps/core lib\0").as_bytes(),
        )
        .unwrap();
        assert_eq!(gitlinks.len(), 1);
        assert_eq!(gitlinks[0].path, "deps/core lib");

        let status = parse_status(
            format!("1 .M S.CU 160000 160000 160000 {oid} {oid} deps/core lib\0").as_bytes(),
        )
        .unwrap();
        assert!(status["deps/core lib"].modified);

        let configs = parse_gitmodules(
            b"submodule.deps/core.path\ndeps/core lib\0submodule.deps/core.url\nhttps://example.com/repo.git\0submodule.deps/core.branch\nmain\0",
        )
        .unwrap();
        assert_eq!(configs[0].name, "deps/core");
        assert_eq!(configs[0].path.as_deref(), Some("deps/core lib"));
        assert_eq!(configs[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn rejects_ambiguous_or_malformed_records() {
        let oid = "a".repeat(40);
        assert_eq!(
            parse_gitlinks(format!("160000 {oid} 4\tdeps/core\0").as_bytes())
                .unwrap_err()
                .code,
            "invalid_git_output"
        );
        assert_eq!(
            parse_gitmodules(b"submodule.core.path\ndeps/core\0submodule.core.path\ndeps/other\0")
                .unwrap_err()
                .code,
            "invalid_gitmodules"
        );
    }
}
