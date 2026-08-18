use crate::domain::TagInfo;
use crate::error::CommandError;

pub fn parse_tags(output: &[u8]) -> Result<Vec<TagInfo>, CommandError> {
    let text = String::from_utf8_lossy(output);
    let mut tags = Vec::new();

    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields = line.split('\0').collect::<Vec<_>>();
        if fields.len() != 7 {
            return Err(CommandError::new(
                "invalid_git_output",
                "无法解析 Git 标签列表",
            ));
        }

        let full_name = fields[0];
        let name = fields[1];
        let oid = fields[2];
        if !full_name.starts_with("refs/tags/")
            || name.is_empty()
            || oid.is_empty()
            || !matches!(fields[3], "commit" | "tag" | "tree" | "blob")
        {
            return Err(CommandError::new(
                "invalid_git_output",
                "Git 标签记录缺少有效字段",
            ));
        }

        let annotated = fields[3] == "tag";
        tags.push(TagInfo {
            name: name.to_owned(),
            full_name: full_name.to_owned(),
            oid: oid.to_owned(),
            target_oid: if annotated && !fields[4].is_empty() {
                fields[4].to_owned()
            } else {
                oid.to_owned()
            },
            annotated,
            subject: (!fields[5].is_empty()).then(|| fields[5].to_owned()),
            tagger_date: (!fields[6].is_empty()).then(|| fields[6].to_owned()),
        });
    }

    tags.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lightweight_and_annotated_tags() {
        let input = [
            [
                "refs/tags/v2.0.0",
                "v2.0.0",
                "bbbb",
                "tag",
                "aaaa",
                "Release 2",
                "2026-08-17T10:00:00+08:00",
            ]
            .join("\0"),
            [
                "refs/tags/v1.0.0",
                "v1.0.0",
                "cccc",
                "commit",
                "",
                "Initial release",
                "",
            ]
            .join("\0"),
        ]
        .join("\n");

        let tags = parse_tags(input.as_bytes()).unwrap();
        assert_eq!(tags[0].name, "v1.0.0");
        assert!(!tags[0].annotated);
        assert_eq!(tags[0].target_oid, "cccc");
        assert_eq!(tags[1].target_oid, "aaaa");
        assert!(tags[1].annotated);
        assert_eq!(tags[1].subject.as_deref(), Some("Release 2"));
    }
}
