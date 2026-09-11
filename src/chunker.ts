import { buildHeadingIndex, getDirectZoneEndLine } from "./headings.js";
import { hashContent } from "./hash.js";
import type { HeadingNode } from "./types.js";

export interface Chunk {
  text: string;
  heading: string;
  filePath: string;
  hash: string;
}

/**
 * Split markdown into embedded chunks using the shared heading parser.
 * Each heading's direct content becomes one chunk; `heading` carries the full
 * heading path ("Parent > Child") so search results address sections directly.
 */
export function chunkMarkdown(content: string, filePath: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = content.split("\n");
  const roots = buildHeadingIndex(content);

  const pushChunk = (text: string, heading: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    chunks.push({
      text: trimmed,
      heading,
      filePath,
      hash: hashContent(`${filePath}:${heading}:${trimmed}`),
    });
  };

  if (roots.length === 0) {
    pushChunk(content, "");
    return chunks;
  }

  // Preamble before the first heading
  if (roots[0].startLine > 1) {
    pushChunk(lines.slice(0, roots[0].startLine - 1).join("\n"), "");
  }

  const walk = (node: HeadingNode, ancestors: string[]) => {
    const headingPath = [...ancestors, node.title].join(" > ");
    const zoneEnd = getDirectZoneEndLine(node);
    pushChunk(lines.slice(node.startLine, zoneEnd).join("\n"), headingPath);
    for (const child of node.children) {
      walk(child, [...ancestors, node.title]);
    }
  };
  for (const root of roots) walk(root, []);

  if (chunks.length === 0 && content.trim()) {
    pushChunk(content, "");
  }

  return chunks;
}
