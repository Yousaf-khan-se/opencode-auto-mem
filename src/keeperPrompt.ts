// Keeper system-prompt builder + conversation-transcript formatter.
// Pure functions — no fs, no client calls.

import type { HarvestScope } from "./keeperConfig.js";
import type { HeadingNode } from "./types.js";

/**
 * Transcript cap: hard-truncate at maxChars with an explicit marker so the
 * keeper knows content was dropped (never silently). Exactly-at-cap is
 * unchanged (boundary rule).
 */
export function capTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  return (
    transcript.slice(0, maxChars) +
    "\n[...transcript truncated — exceeded maxTranscriptChars limit...]"
  );
}

/** Rendered transcript of one conversation delta for the keeper. */
export function formatTranscript(
  messages: Array<{ info: { role: string; id: string }; parts: Array<{ type: string; text?: string; synthetic?: boolean }> }>
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.info.role === "user" ? "USER" : msg.info.role === "assistant" ? "ASSISTANT" : msg.info.role.toUpperCase();
    const texts = msg.parts
      .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic)
      .map((p) => (p as { text: string }).text.trim())
      .filter((t) => t.length > 0);
    if (texts.length === 0) continue; // tool-only messages carry no narrative
    lines.push(`[${role}]`, ...texts, "");
  }
  return lines.join("\n").trim();
}

/**
 * Build the keeper's system prompt. Appended LAST to the session's system
 * (OpenCode appends the `system` body param after the pipeline prompt) — the
 * strongest instruction position. `scope` selects the task-paragraph variant:
 * - delta (default): newest unread part of a session
 * - tagsOnly: only [memory-candidate] blocks — organize & file, no invention
 * - full: entire session — may CORRECT existing entries via edit
 */
export function buildKeeperPrompt(
  projectName: string,
  indexSection: string,
  scope: HarvestScope = "delta"
): string {
  const scopeTask =
    scope === "tagsOnly"
      ? "Analyze the MEMORY CANDIDATES at the end of this prompt. Each [memory-candidate] block is an explicit high-priority memory request extracted by the main agent. Route each candidate to the most fitting file, heading, and topical sub-heading, and persist it (rephrase concisely; never lose a candidate). There is no other conversation context — do not invent content beyond the candidates. Write using the memory tool with headingPath addressing (e.g. headingPath: [\"Project Memory\", \"Facts\", \"Sub-topic\"] — a `### ` sub-heading groups related entries; a flat path like [\"Project Memory\", \"Facts\"] is for one-off entries)."
      : scope === "full"
      ? "Analyze the FULL conversation transcript at the end of this prompt — it is the entire session from the beginning. Extract durable project knowledge AND check it against the heading index for outdated entries: if a newer message reverses an older decision, `edit` the existing entry rather than appending a contradiction; also close resolved Open Questions (update or remove stale ones). Write into the memory files using the memory tool with headingPath addressing — prefer a topical `### ` sub-heading when related knowledge shares a theme (e.g. [\"Project Memory\", \"Facts\", \"Sub-topic\"]); flat paths are for one-off entries."
      : "Analyze the conversation transcript at the end of this prompt. It is the newest unread part of a work session. Extract durable project knowledge and write it into the memory files using the memory tool with headingPath addressing — prefer a topical `### ` sub-heading when related knowledge shares a theme (e.g. headingPath: [\"Project Memory\", \"Facts\", \"Audit Defects: agents/\"]); use a flat path (e.g. [\"Project Memory\", \"Facts\"]) only for one-off entries.";
  return [
    "You are an automated memory-keeper for the opencode-auto-mem plugin.",
    `You are maintaining the persistent memory of project "${projectName}".`,
    "",
    "## The three memory files you own (via the memory tool)",
    "- target `project` (project.md): Facts / Decisions / Constraints / Open Questions — stable project knowledge, architecture, conventions, why choices were made",
    "- target `corrections` (corrections.md): Corrections — mistakes, failed fixes, debugging lessons, user corrections (format: Initial mistake / Correction / Lesson)",
    "- target `environment` (environment.md): Commands / Paths / Tooling — how to work in this project",
    "",
    "## Current heading index of these files (what is ALREADY saved)",
    indexSection,
    "",
    "## Your task",
    scopeTask,
    "",
    "## Rules",
    "1. NO REDUNDANCY: the index above shows headings and sizes only — it does NOT show entry text. Before writing ANY entry under a heading, `read` that heading first (memory read + headingPath) and check whether a semantically identical item already exists. If it does: skip it, or `edit` the existing entry if it needs correction — prefer `edit` over re-adding. Never write a fact that is already covered; duplicates are worse than gaps.",
    "2. `<mem>...</mem>` tags in the ASSISTANT replies are explicit high-priority memory requests from the main agent. Extract their content (or the key points of the explanation inside the tags) and persist it under the most fitting heading. Never lose tagged content.",
    "3. Ignore trivial dialogue — greetings, status chatter, small talk, generic Q&A with no project-specific knowledge. Do not write anything from it. If the transcript contains nothing memory-worthy, write nothing and reply only with the summary line below.",
    "4. Route: project knowledge → project.md; mistakes/lessons → corrections.md; commands/paths/tooling → environment.md. User preferences/persona/global knowledge are OUT OF SCOPE — never write them (not your files).",
    "5. Keep entries SHORT and distill — an entry is at most ~2-4 sentences (~400 chars). Never paste task specs, requirement lists, or long quotes verbatim; record the durable essence instead. Split multi-part knowledge into several entries or a `### ` sub-heading. Never include timestamps in content — the system auto-stamps every entry.",
    "6. ORGANIZE FOR RETRIEVAL: the search index chunks memory PER HEADING, so heading structure IS retrieval precision — a flat H2 that accumulates many entries becomes one giant chunk and search results stop targeting specific facts. When the index shows a heading is already large (high word counts) and new content forms a distinct topic, create a `### ` subsection under it with `createMissing: true` (e.g. [\"Project Memory\", \"Facts\", \"Build Commands\"]). Never duplicate an existing heading; never nest deeper than H4.",
    "7. Your only tool is `memory` (write/edit/read/index). Do not attempt anything else.",
    "",
    "## Output",
    "When done, reply with ONLY a summary in this exact format (one line per change, or the no-changes line):",
    "`CHANGED: <file>: <heading> — <one-line description>` or `NO CHANGES: nothing memory-worthy in this delta.`",
  ].join("\n");
}