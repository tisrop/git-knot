import { useEffect, useMemo, useState } from "react";
import {
  buildSplitDiffRows,
  isAddedFileDiff,
  type SplitDiffCell,
  type UnifiedDiff,
} from "../history/history";

const DIFF_INITIAL_ROWS = 500;
const DIFF_ROWS_PER_LOAD = 500;

export function UnifiedDiffView({ diff }: { diff: UnifiedDiff }) {
  const addedFile = useMemo(() => isAddedFileDiff(diff), [diff]);
  const visibleLines = useMemo(() => {
    const meaningfulLines = diff.lines.filter((line) => !isRedundantDiffHeader(line));
    return meaningfulLines.length > 0 ? meaningfulLines : diff.lines;
  }, [diff.lines]);
  const rows = useMemo(
    () => buildSplitDiffRows({ ...diff, lines: visibleLines }),
    [diff, visibleLines],
  );
  const [visibleRowCount, setVisibleRowCount] = useState(DIFF_INITIAL_ROWS);

  useEffect(() => {
    setVisibleRowCount(DIFF_INITIAL_ROWS);
  }, [diff]);

  const visibleRows = rows.slice(0, visibleRowCount);
  const hasMoreRows = visibleRowCount < rows.length;

  return (
    <div className={`split-diff-view wrap-lines${addedFile ? " added-file" : ""}`}>
      <div className="split-diff-columns" aria-hidden="true">
        {!addedFile ? <span>旧版本</span> : null}
        <span>新版本</span>
      </div>
      <div
        className="split-diff-scroll"
        tabIndex={0}
        role="region"
        aria-label={addedFile ? "新增文件差异内容" : "左右对照差异内容"}
      >
        <table className="split-diff-table">
          <colgroup>
            {!addedFile ? (
              <>
                <col className="split-diff-number-column" />
                <col className="split-diff-marker-column" />
                <col className="split-diff-code-column" />
              </>
            ) : null}
            <col className="split-diff-number-column" />
            <col className="split-diff-marker-column" />
            <col className="split-diff-code-column" />
          </colgroup>
          <tbody>
            {visibleRows.map((row, index) =>
              row.kind === "code" ? (
                <tr className="split-diff-row code" key={`code:${index}`}>
                  {!addedFile ? <SplitDiffCells cell={row.old} side="old" /> : null}
                  <SplitDiffCells cell={row.new} side="new" />
                </tr>
              ) : (
                <tr className={`split-diff-row ${row.kind}`} key={`${row.kind}:${index}`}>
                  <td colSpan={addedFile ? 3 : 6}>
                    <code>{row.content || " "}</code>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {hasMoreRows ? (
          <div className="split-diff-load-more">
            <p>
              已显示 {visibleRows.length.toLocaleString("zh-CN")} /{" "}
              {rows.length.toLocaleString("zh-CN")} 行
            </p>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() =>
                setVisibleRowCount((count) => Math.min(count + DIFF_ROWS_PER_LOAD, rows.length))
              }
            >
              显示更多差异
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SplitDiffCells({ cell, side }: { cell: SplitDiffCell | null; side: "old" | "new" }) {
  const kind = cell?.kind ?? "empty";
  const marker = cell?.kind === "deletion" ? "−" : cell?.kind === "addition" ? "+" : "";
  return (
    <>
      <td className={`split-diff-number ${side} ${kind}`}>{cell?.lineNumber ?? ""}</td>
      <td className={`split-diff-marker ${side} ${kind}`} aria-hidden="true">
        {marker}
      </td>
      <td className={`split-diff-code ${side} ${kind}`}>
        <code>{cell?.content || " "}</code>
      </td>
    </>
  );
}

function isRedundantDiffHeader(line: UnifiedDiff["lines"][number]) {
  if (line.kind !== "file") return false;
  return (
    line.content.startsWith("diff --git ") ||
    line.content.startsWith("index ") ||
    line.content.startsWith("--- ") ||
    line.content.startsWith("+++ ") ||
    line.content.startsWith("new file mode ") ||
    line.content.startsWith("deleted file mode ")
  );
}
