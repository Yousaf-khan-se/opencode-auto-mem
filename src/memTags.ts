// Pure <mem> tag extraction — no fs, no client calls. Used by the tags
// trigger mode to decide whether a conversation delta warrants a harvest.

export interface MemTagMatch {
  /** Trimmed content inside the <mem>...</mem> block. */
  tag: string;
  /** The tag's own line plus up to `contextLines` lines above it. */
  context: string;
}

const MEM_TAG_RE = /<mem>([\s\S]*?)<\/mem>/gi;

/**
 * Extract all complete <mem>...</mem> blocks from text. Unterminated tags
 * (no closing </mem>) are ignored — they are handled by pairing the tail of
 * the previous message via buildTagScanText. Case-insensitive; empty tag
 * bodies are skipped.
 */
export function extractMemTags(text: string, contextLines = 2): MemTagMatch[] {
  if (!text) return [];
  const out: MemTagMatch[] = [];
  const lines = text.split("\n");
  MEM_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEM_TAG_RE.exec(text)) !== null) {
    const tag = m[1].trim();
    if (!tag) continue;
    const lineIdx = text.slice(0, m.index).split("\n").length - 1;
    const context = lines
      .slice(Math.max(0, lineIdx - contextLines), lineIdx + 1)
      .join("\n")
      .trim();
    out.push({ tag, context });
  }
  return out;
}

/**
 * Transcript text to scan for tags. A tag opened at the very end of the
 * previous checkpoint's last message and closed inside the new delta is
 * invisible to a transcript-only scan — prefixing a short tail of the
 * previous message closes that gap.
 */
export function buildTagScanText(transcript: string, prevTail?: string): string {
  const tail = (prevTail ?? "").trim();
  if (!tail) return transcript;
  return `${tail}\n${transcript}`;
}

/**
 * tagsOnly transcript: numbered memory candidates — the tag content plus a
 * couple of surrounding context lines each. Excludes ALL untagged narrative
 * (the whole point of the scope: the keeper receives only what the main
 * agent explicitly marked).
 */
export function formatMemTags(matches: MemTagMatch[]): string {
  if (matches.length === 0) return "";
  return matches
    .map((m, i) => `[memory-candidate #${i + 1}]\n${m.context}\n>>> ${m.tag}`)
    .join("\n\n");
}