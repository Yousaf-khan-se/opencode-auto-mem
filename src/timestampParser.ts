import type { TimestampEntry } from "./types.js";

// Non-sticky /g: used as a split separator (stateless). findFirstTimestamp
// below uses its own non-global probe for single first-match semantics.
const TIMESTAMP_REGEX =
  /<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)\s*-->/g;

/** First timestamp comment in a file, or null. */
export function findFirstTimestamp(content: string): RegExpMatchArray | null {
  const probe = /<!--\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)\s*-->/;
  return content.match(probe);
}

export function parseContentByTimestamp(content: string): TimestampEntry[] {
  const entries: TimestampEntry[] = [];
  const parts = content.split(TIMESTAMP_REGEX);

  for (let i = 1; i < parts.length; i += 2) {
    const timestamp = parts[i];
    const nextContent = parts[i + 1] || "";

    const contentParts = nextContent.split(TIMESTAMP_REGEX);
    const entryContent = contentParts[0].trim();

    if (entryContent) {
      entries.push({
        timestamp,
        content: entryContent,
      });
    }
  }

  return entries;
}

export function extractTimestamps(content: string): string[] {
  const timestamps: string[] = [];
  let match;

  while ((match = TIMESTAMP_REGEX.exec(content)) !== null) {
    timestamps.push(match[1]);
  }

  return timestamps;
}

const ORPHAN_TS_REGEX = /^<!--\s*\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?\s*-->$/;

/**
 * Remove timestamp comments that lost their entry content (section deletes
 * could remove an entry's text while leaving its `<!-- ts -->` behind).
 * A ts comment is ORPHANED when only whitespace follows it up to the next
 * ts comment, the next heading, or EOF — i.e. it introduces no content at
 * all. A ts followed by real content (or by another ts that eventually has
 * content) is preserved.
 */
export function stripOrphanTimestamps(text: string): string {
  const lines = text.split("\n");
  const isTsComment = (line: string): boolean => ORPHAN_TS_REGEX.test(line.trim());
  const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line.trim());

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTsComment(line)) {
      // Look ahead: if every line until the next boundary (ts / heading /
      // EOF) is whitespace-only, this ts introduces no content → orphan.
      let j = i + 1;
      let orphan = true;
      while (j < lines.length) {
        const next = lines[j];
        if (isTsComment(next) || isHeading(next)) break;
        if (next.trim() !== "") {
          orphan = false;
          break;
        }
        j++;
      }
      if (orphan) {
        // Skip the ts line, plus ONE adjacent blank line so removing the
        // entry doesn't leave a doubled blank gap (or a trailing run).
        if (lines[i + 1]?.trim() === "" && (kept.length === 0 || kept[kept.length - 1] === "")) {
          i++; // swallow the following blank too
        }
        continue;
      }
    }
    kept.push(line);
  }
  // Collapse any doubled blanks the removal may have created.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}
