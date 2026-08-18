use crate::domain::StashInfo;
use crate::error::CommandError;

const STASH_FIELDS: usize = 4;
const MAX_STASH_SELECTOR_BYTES: usize = 1024;

pub fn parse_stashes(output: &[u8]) -> Result<Vec<StashInfo>, CommandError> {
    let text = String::from_utf8_lossy(output);
    let mut stashes = Vec::new();

    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() != STASH_FIELDS {
            return Err(CommandError::new(
                "invalid_git_output",
                "无法解析 Git 储藏列表",
            ));
        }

        let oid = fields[0];
        let selector = fields[1];
        let valid_oid =
            matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit());
        let valid_selector = selector.starts_with("stash@{")
            && selector.ends_with('}')
            && selector.len() <= MAX_STASH_SELECTOR_BYTES
            && !selector.bytes().any(|byte| byte.is_ascii_control());
        if !valid_oid || !valid_selector || fields[3].is_empty() {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git 储藏记录缺少有效字段",
            ));
        }

        stashes.push(StashInfo {
            selector: selector.to_owned(),
            oid: oid.to_owned(),
            subject: fields[2].to_owned(),
            created_at: fields[3].to_owned(),
        });
    }

    Ok(stashes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ordered_stash_records() {
        let input = [
            [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "stash@{0}",
                "On main: first",
                "2026-08-17T10:00:00+08:00",
            ]
            .join("\0"),
            [
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "stash@{1}",
                "WIP on main: older",
                "2026-08-16T10:00:00+08:00",
            ]
            .join("\0"),
        ]
        .join("\n");

        let stashes = parse_stashes(input.as_bytes()).unwrap();
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].selector, "stash@{0}");
        assert_eq!(stashes[1].subject, "WIP on main: older");
    }

    #[test]
    fn rejects_non_authoritative_records() {
        for input in [
            "HEAD\0stash@{0}\0subject\x002026-08-17T10:00:00+08:00",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0refs/stash\0subject\x002026-08-17T10:00:00+08:00",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0stash@{0}\0subject\0",
        ] {
            assert_eq!(parse_stashes(input.as_bytes()).unwrap_err().code, "invalid_git_output");
        }
    }
}
