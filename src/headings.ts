// Pure markdown heading-tree utilities: index building, section addressing,
// extraction, insertion and prompt-friendly rendering. No filesystem access.

import type { HeadingNode } from "./types.js";

const HEADING_REGEX = /^(#{1,6})\s+(.*)$/;
const FENCE_REGEX = /^\s*(`{3,}|~{3,})/;

interface TitleWithOrdinal {
  title: string;
  ordinal?: number;
}

/**
 * Parse "Title#2" into { title: "Title", ordinal: 2 }.
 * Used to disambiguate duplicate sibling headings (legacy files only —
 * the tool rejects creating duplicates).
 */
export function parseTitleOrdinal(raw: string): TitleWithOrdinal {
  const match = raw.match(/^(.+)#(\d+)$/);
  if (match && match[1].trim()) {
    return { title: match[1].trim(), ordinal: parseInt(match[2], 10) };
  }
  return { title: raw.trim() };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/**
 * Build a heading tree from markdown content.
 * - Handles H1-H6.
 * - Ignores heading markers inside fenced code blocks (``` or ~~~).
 * - Direct content lines are assigned to the deepest open heading.
 * - Lines are 1-based; endLine is inclusive.
 */
export function buildHeadingIndex(content: string): HeadingNode[] {
  const lines = content.split("\n");
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  let inFence = false;
  let fenceChar = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const fenceMatch = line.match(FENCE_REGEX);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (fenceChar === fenceMatch[1][0]) {
        inFence = false;
      }
      const top = stack[stack.length - 1];
      if (top) top.directChars += line.length;
      continue;
    }
    if (inFence) {
      const top = stack[stack.length - 1];
      if (top) {
        top.directWords += countWords(line);
        top.directChars += line.trim().length;
        top.endLine = lineNo;
      }
      continue;
    }

    const headingMatch = line.match(HEADING_REGEX);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const node: HeadingNode = {
        level,
        title,
        directWords: 0,
        directChars: 0,
        totalWords: 0,
        totalChars: 0,
        startLine: lineNo,
        endLine: lineNo,
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }

    const top = stack[stack.length - 1];
    if (top) {
      top.directWords += countWords(line);
      top.directChars += line.trim().length;
      top.endLine = lineNo;
    }
  }

  const finalize = (node: HeadingNode): void => {
    let totalWords = node.directWords;
    let totalChars = node.directChars;
    let endLine = node.startLine;
    for (const child of node.children) {
      finalize(child);
      totalWords += child.totalWords;
      totalChars += child.totalChars;
      endLine = Math.max(endLine, child.endLine);
    }
    node.totalWords = totalWords;
    node.totalChars = totalChars;
    node.endLine = Math.max(endLine, node.endLine);
  };
  for (const root of roots) finalize(root);

  return roots;
}

export type SectionLookup = { node: HeadingNode } | { error: string };

/** Strict lookup: exact title match at each level, with descriptive errors. */
export function findSection(
  roots: HeadingNode[],
  headingPath: string[]
): SectionLookup {
  let candidates = roots;
  let current: HeadingNode | null = null;
  const walked: string[] = [];

  for (const raw of headingPath) {
    const { title, ordinal } = parseTitleOrdinal(raw);
    const scope =
      walked.length > 0
        ? `under "${walked.join(" > ")}"`
        : "at the document root";
    const matches = candidates.filter((n) => n.title === title);

    if (matches.length === 0) {
      const available = candidates.map((n) => `"${n.title}"`).join(", ");
      return {
        error: `Heading "${title}" not found ${scope}. Available headings: ${
          available || "(none)"
        }. Fetch the current index with the "index" action and try again.`,
      };
    }
    if (matches.length > 1 && !ordinal) {
      const options = matches
        .map((_, idx) => `"${title}#${idx + 1}"`)
        .join(", ");
      return {
        error: `Multiple headings titled "${title}" exist ${scope} (legacy duplicates). Disambiguate using: ${options}`,
      };
    }
    const index = ordinal ? ordinal - 1 : 0;
    if (index >= matches.length) {
      return {
        error: `Ordinal #${ordinal} is out of range for "${title}" ${scope}: only ${matches.length} match(es) exist.`,
      };
    }
    current = matches[index];
    walked.push(title);
    candidates = current.children;
  }

  if (!current) {
    return {
      error: "headingPath must be a non-empty array of heading titles.",
    };
  }
  return { node: current };
}

/**
 * Tolerant walk used by the createMissing flow: returns the deepest node that
 * matches a prefix of the path, how many segments matched, and an ambiguity
 * error if a segment matched multiple siblings without an ordinal.
 */
export function findDeepest(
  roots: HeadingNode[],
  headingPath: string[]
): { node?: HeadingNode; consumed: number; ambiguous?: string } {
  let candidates = roots;
  let node: HeadingNode | undefined;
  let consumed = 0;

  for (let i = 0; i < headingPath.length; i++) {
    const { title, ordinal } = parseTitleOrdinal(headingPath[i]);
    const matches = candidates.filter((n) => n.title === title);
    if (matches.length === 0) return { node, consumed };
    if (matches.length > 1) {
      if (ordinal && ordinal <= matches.length) {
        node = matches[ordinal - 1];
      } else {
        return {
          node,
          consumed,
          ambiguous: `Multiple headings titled "${title}" exist at this position. Disambiguate with an ordinal suffix like "${title}#2", or fetch the index with the "index" action.`,
        };
      }
    } else {
      node = matches[0];
    }
    candidates = node.children;
    consumed = i + 1;
  }
  return { node, consumed };
}

/** The heading line plus everything under it (including subsections). */
export function extractSection(node: HeadingNode, content: string): string {
  const lines = content.split("\n");
  return lines
    .slice(node.startLine - 1, node.endLine)
    .join("\n")
    .trim();
}

/** Last line (1-based) of the node's direct content zone: after the heading, before the first subsection. */
export function getDirectZoneEndLine(node: HeadingNode): number {
  return node.children.length > 0
    ? node.children[0].startLine - 1
    : node.endLine;
}

/** Insert text at the end of the node's direct content zone (before any subsections). */
export function insertUnderHeading(
  content: string,
  node: HeadingNode,
  text: string
): string {
  const lines = content.split("\n");
  const insertAt = getDirectZoneEndLine(node); // 0-based splice index = this 1-based line number
  const prev = (lines[insertAt - 1] ?? "").trim();
  const block = prev !== "" ? ["", ...text.split("\n")] : text.split("\n");
  lines.splice(insertAt, 0, ...block);
  return lines.join("\n");
}

function renderNodeLines(
  node: HeadingNode,
  prefix: string,
  isLast: boolean,
  lines: string[]
): void {
  const branch = isLast ? "└─ " : "├─ ";
  lines.push(
    `${prefix}${branch}${node.title} (${node.directWords}/${node.totalWords})`
  );
  const childPrefix = prefix + (isLast ? "   " : "│  ");
  node.children.forEach((child, idx) => {
    renderNodeLines(child, childPrefix, idx === node.children.length - 1, lines);
  });
}

/** Compact prompt-friendly table of contents with direct/total word counts. */
export function renderIndexText(
  fileName: string,
  roots: HeadingNode[]
): string {
  const directWords = roots.reduce((acc, n) => acc + n.directWords, 0);
  const totalWords = roots.reduce((acc, n) => acc + n.totalWords, 0);
  const lines = [
    `${fileName} — ${directWords} direct / ${totalWords} total words (direct/total per heading)`,
  ];
  roots.forEach((root, idx) => {
    renderNodeLines(root, "", idx === roots.length - 1, lines);
  });
  if (roots.length === 0) lines.push("(no headings yet)");
  return lines.join("\n");
}