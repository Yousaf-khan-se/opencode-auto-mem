export interface MemoryConfig {
  memoryDir: string;
  projectDir?: string;
  currentProjectName?: string | null;
}

export type MemoryTarget = "memory" | "identity" | "user" | "project" | "corrections" | "environment";

export interface TimestampEntry {
  timestamp: string;
  content: string;
}

export interface SemanticSearchResult {
  score: number;
  filePath: string;
  heading: string;
  text: string;
  timestamp?: string;
}

export interface MonthGroup {
  month: string;
  fileCount: number;
  entryCount: number;
  files: Array<{ name: string; timestamps: string[] }>;
}

export interface ContextFile {
  name: string;
  content: string;
}

// File entry with timestamps - used for listing files
export interface FileEntry {
  name: string;
  timestamps: string[];
}

// Return type for listFilesGroupedByMonth
export interface GroupedFiles {
  root: FileEntry[];
  project: FileEntry[];
  monthly: MonthGroup[];
}

// Memory operation entry for session tracking
export interface SessionMemoryOperation {
  action: string;
  target: string;
  timestamp: string;
}

// Session state tracking
export interface SessionState {
  memoryOperations: SessionMemoryOperation[];
}

// Heading tree node used by the markdown index system (see headings.ts)
export interface HeadingNode {
  level: number; // 1-6
  title: string; // heading text without the # markers
  directWords: number; // words directly under this heading (before subsections)
  directChars: number;
  totalWords: number; // cumulative: subtree including this heading's direct content
  totalChars: number;
  startLine: number; // 1-based line of the heading itself
  endLine: number; // 1-based last line of the whole subtree (inclusive)
  children: HeadingNode[];
}
