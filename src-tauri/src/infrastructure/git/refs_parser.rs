use crate::domain::{BranchInfo, BranchKind};
use crate::error::CommandError;

pub fn parse_branches(output: &[u8]) -> Result<Vec<BranchInfo>, CommandError> {
    let text = String::from_utf8_lossy(output);
    let mut branches = Vec::new();

    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() != 8 {
            return Err(CommandError::new(
                "invalid_git_output",
                "无法解析 Git 分支列表",
            ));
        }

        let full_name = fields[0];
        let name = fields[1];
        if full_name.is_empty() || name.is_empty() {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git 分支记录缺少名称",
            ));
        }
        if !fields[7].is_empty() {
            continue;
        }

        let kind = if full_name.starts_with("refs/heads/") {
            BranchKind::Local
        } else if full_name.starts_with("refs/remotes/") {
            BranchKind::Remote
        } else {
            continue;
        };
        let (ahead, behind, upstream_missing) = parse_tracking(fields[6])?;
        branches.push(BranchInfo {
            name: name.to_owned(),
            full_name: full_name.to_owned(),
            kind,
            current: kind == BranchKind::Local && fields[3] == "*",
            oid: fields[2].to_owned(),
            upstream: (!fields[4].is_empty()).then(|| fields[4].to_owned()),
            upstream_missing,
            ahead,
            behind,
        });
    }

    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| kind_order(left.kind).cmp(&kind_order(right.kind)))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(branches)
}

fn kind_order(kind: BranchKind) -> u8 {
    match kind {
        BranchKind::Local => 0,
        BranchKind::Remote => 1,
    }
}

fn parse_tracking(value: &str) -> Result<(u64, u64, bool), CommandError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok((0, 0, false));
    }
    if value == "[gone]" {
        return Ok((0, 0, true));
    }

    let content = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .ok_or_else(|| CommandError::new("invalid_git_output", "无法解析分支 ahead/behind"))?;
    let mut ahead = 0;
    let mut behind = 0;
    for part in content.split(',').map(str::trim) {
        if let Some(value) = part.strip_prefix("ahead ") {
            ahead = value
                .parse()
                .map_err(|_| CommandError::new("invalid_git_output", "无法解析分支 ahead 数量"))?;
        } else if let Some(value) = part.strip_prefix("behind ") {
            behind = value
                .parse()
                .map_err(|_| CommandError::new("invalid_git_output", "无法解析分支 behind 数量"))?;
        } else {
            return Err(CommandError::new(
                "invalid_git_output",
                "无法解析分支 ahead/behind",
            ));
        }
    }
    Ok((ahead, behind, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_sorts_local_and_remote_branches() {
        let input = [
            [
                "refs/remotes/origin/main",
                "origin/main",
                "aaa",
                " ",
                "",
                "",
                "",
                "",
            ]
            .join("\0"),
            [
                "refs/heads/topic",
                "topic",
                "bbb",
                " ",
                "origin/topic",
                "refs/remotes/origin/topic",
                "[ahead 2, behind 1]",
                "",
            ]
            .join("\0"),
            [
                "refs/heads/main",
                "main",
                "ccc",
                "*",
                "origin/main",
                "refs/remotes/origin/main",
                "",
                "",
            ]
            .join("\0"),
            [
                "refs/remotes/origin/HEAD",
                "origin/HEAD",
                "ccc",
                " ",
                "",
                "",
                "",
                "refs/remotes/origin/main",
            ]
            .join("\0"),
        ]
        .join("\n");

        let branches = parse_branches(input.as_bytes()).unwrap();
        assert_eq!(branches.len(), 3);
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].current);
        assert_eq!(branches[1].name, "topic");
        assert_eq!(branches[1].ahead, 2);
        assert_eq!(branches[1].behind, 1);
        assert!(matches!(branches[2].kind, BranchKind::Remote));
    }

    #[test]
    fn recognizes_missing_upstream() {
        let input = [
            "refs/heads/topic",
            "topic",
            "bbb",
            " ",
            "origin/topic",
            "refs/remotes/origin/topic",
            "[gone]",
            "",
        ]
        .join("\0");
        let branch = parse_branches(input.as_bytes()).unwrap().remove(0);
        assert!(branch.upstream_missing);
    }
}
