export type DiffLineType = "same" | "add" | "remove";

export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
  readonly oldNumber?: number;
  readonly newNumber?: number;
}

export interface DiffHunk {
  readonly lines: readonly DiffLine[];
}

/** A line diff by longest common subsequence; manifests are small enough for O(n·m). */
export const diffLines = (before: string, after: string): DiffLine[] => {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;

  // Trim the common prefix and suffix first: most edits are small.
  let start = 0;

  while (start < n && start < m && a[start] === b[start]) {
    start++;
  }

  let endA = n;
  let endB = m;

  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const rows = endA - start;
  const cols = endB - start;
  const table: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] = a[start + i] === b[start + j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];

  for (let k = 0; k < start; k++) {
    result.push({ type: "same", text: a[k], oldNumber: k + 1, newNumber: k + 1 });
  }

  let i = 0;
  let j = 0;

  while (i < rows || j < cols) {
    if (i < rows && j < cols && a[start + i] === b[start + j]) {
      result.push({ type: "same", text: a[start + i], oldNumber: start + i + 1, newNumber: start + j + 1 });
      i++;
      j++;
    } else if (j < cols && (i >= rows || table[i][j + 1] >= table[i + 1][j])) {
      result.push({ type: "add", text: b[start + j], newNumber: start + j + 1 });
      j++;
    } else {
      result.push({ type: "remove", text: a[start + i], oldNumber: start + i + 1 });
      i++;
    }
  }

  for (let k = 0; k < n - endA; k++) {
    result.push({ type: "same", text: a[endA + k], oldNumber: endA + k + 1, newNumber: endB + k + 1 });
  }

  return result;
};

/** Groups a diff into hunks with `context` unchanged lines around each change. */
export const toHunks = (lines: readonly DiffLine[], context = 3): DiffHunk[] => {
  const changed = lines.map((line, index) => (line.type === "same" ? -1 : index)).filter((index) => index >= 0);

  if (changed.length === 0) {
    return [];
  }

  const hunks: DiffHunk[] = [];
  let from = Math.max(0, changed[0] - context);
  let to = Math.min(lines.length - 1, changed[0] + context);

  for (const index of changed.slice(1)) {
    if (index - context <= to + 1) {
      to = Math.min(lines.length - 1, index + context);
    } else {
      hunks.push({ lines: lines.slice(from, to + 1) });
      from = Math.max(0, index - context);
      to = Math.min(lines.length - 1, index + context);
    }
  }

  hunks.push({ lines: lines.slice(from, to + 1) });

  return hunks;
};

export const diffStats = (lines: readonly DiffLine[]) => ({
  added: lines.filter((line) => line.type === "add").length,
  removed: lines.filter((line) => line.type === "remove").length,
});
