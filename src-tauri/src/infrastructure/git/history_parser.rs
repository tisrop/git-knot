use crate::domain::{CommitFileChange, CommitSummary};
use crate::error::CommandError;

const HISTORY_FIELD_COUNT: usize = 6;
const DETAILS_FIELD_COUNT: usize = 7;

pub fn parse_history(output: &[u8]) -> Result<Vec<CommitSummary>, CommandError> {
    let mut fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if fields.is_empty() {
        return Ok(Vec::new());
    }
    if fields.len() % HISTORY_FIELD_COUNT != 0 {
        return Err(invalid_history_output());
    }

    fields
        .chunks_exact(HISTORY_FIELD_COUNT)
        .map(parse_summary_fields)
        .collect()
}

pub fn parse_commit_metadata(output: &[u8]) -> Result<(CommitSummary, String), CommandError> {
    let mut fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    while fields.last().is_some_and(|field| field.is_empty()) && fields.len() > DETAILS_FIELD_COUNT
    {
        fields.pop();
    }
    if fields.len() != DETAILS_FIELD_COUNT {
        return Err(CommandError::new(
            "invalid_git_output",
            "无法解析 Git 提交详情",
        ));
    }

    let summary = parse_summary_fields(&fields[..HISTORY_FIELD_COUNT])?;
    let body = text(fields[6]);
    Ok((summary, body))
}

pub fn parse_name_status(output: &[u8]) -> Result<Vec<CommitFileChange>, CommandError> {
    let records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut changes = Vec::new();
    let mut index = 0;

    while index < records.len() {
        let status = text(records[index]);
        index += 1;
        if status.is_empty() {
            return Err(invalid_name_status_output());
        }

        let is_copy_or_rename = matches!(status.as_bytes().first(), Some(b'C' | b'R'));
        if is_copy_or_rename {
            let original_path = records.get(index).ok_or_else(invalid_name_status_output)?;
            let path = records
                .get(index + 1)
                .ok_or_else(invalid_name_status_output)?;
            index += 2;
            changes.push(CommitFileChange {
                status,
                path: text(path),
                original_path: Some(text(original_path)),
            });
        } else {
            let path = records.get(index).ok_or_else(invalid_name_status_output)?;
            index += 1;
            changes.push(CommitFileChange {
                status,
                path: text(path),
                original_path: None,
            });
        }
    }

    Ok(changes)
}

fn parse_summary_fields(fields: &[&[u8]]) -> Result<CommitSummary, CommandError> {
    if fields.len() != HISTORY_FIELD_COUNT || fields[0].is_empty() {
        return Err(invalid_history_output());
    }
    Ok(CommitSummary {
        oid: text(fields[0]),
        parent_oids: text(fields[1])
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        author_name: text(fields[2]),
        author_email: text(fields[3]),
        authored_at: text(fields[4]),
        subject: text(fields[5]),
    })
}

fn text(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

fn invalid_history_output() -> CommandError {
    CommandError::new("invalid_git_output", "无法解析 Git 提交历史")
}

fn invalid_name_status_output() -> CommandError {
    CommandError::new("invalid_git_output", "无法解析 Git 提交文件列表")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_history_with_root_and_merge_commits() {
        let input = concat!(
            "abc\0one two\0Alice\0alice@example.com\02026-08-16T10:00:00+08:00\0Merge branch\0",
            "def\0\0Bob\0bob@example.com\02026-08-15T10:00:00+08:00\0Initial commit\0",
        );
        let commits = parse_history(input.as_bytes()).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parent_oids, vec!["one", "two"]);
        assert!(commits[1].parent_oids.is_empty());
    }

    #[test]
    fn parses_renamed_and_modified_files() {
        let input = b"R100\0old name.txt\0new name.txt\0M\0src/main.rs\0";
        let changes = parse_name_status(input).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "new name.txt");
        assert_eq!(changes[0].original_path.as_deref(), Some("old name.txt"));
        assert_eq!(changes[1].status, "M");
    }
}
