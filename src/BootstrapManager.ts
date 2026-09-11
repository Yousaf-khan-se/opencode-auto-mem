import { MemoryManager } from "./MemoryManager.js";
import { MEMORY_AWARENESS_INSTRUCTIONS } from "./memoryInstructions.js";

const BOOTSTRAP_TEMPLATE = (
  bootstrapPath: string
) => `# BOOTSTRAP.md - First Time Setup

**IMPORTANT:** First setup must be done in OpenCode **build mode** (not plan mode). AI cannot write files in plan mode.

**Bootstrap file location:** \`${bootstrapPath}\`

This is your first run! Let's set up your memory system.

## Instructions

Ask the user the following questions and fill in the memory files:

### For IDENTITY.md
Ask the user:
1. What name should the AI call itself?
2. What's the AI's personality/vibe? (e.g., professional, casual, critical, helpful)
3. What languages should the AI use?
4. Any specific behavioral rules?

### For USER.md
Ask the user:
1. What's your name? (how should AI address you)
2. What's your role/profession?
3. What programming languages/frameworks do you work with?
4. Where are you located? (timezone relevant)
5. What's your communication style preference?
6. Any specific preferences or constraints?

### For MEMORY.md
Ask the user:
1. Any crucial technical knowledge to remember?
2. Any system configurations or paths to remember?
3. Any preferences about how code should be written?

## After Setup

Once you've collected all the information:
1. Write to IDENTITY.md, USER.md, and MEMORY.md using the memory tool
2. Delete this BOOTSTRAP.md file: \`rm ${bootstrapPath}\`
3. Confirm setup is complete to the user

Be conversational and natural. Don't overwhelm with all questions at once.

---
${MEMORY_AWARENESS_INSTRUCTIONS.trim()}
`;

const MEMORY_TEMPLATE = `# MEMORY.md - Long-Term Memory

Crucial facts, decisions, and preferences that persist across sessions.

## Technical Knowledge

## Preferences

## Important Facts
`;

const PROJECT_TEMPLATE = `# Project Memory

## Facts

## Decisions

## Constraints

## Open Questions
`;

const CORRECTIONS_TEMPLATE = `# Corrective Memory

## Corrections
`;

const ENVIRONMENT_TEMPLATE = `# Environment Memory

## Commands

## Paths

## Tooling
`;

const IDENTITY_TEMPLATE = `# IDENTITY.md - Agent Identity

- **Name**: (AI's name)
- **Vibe**: (personality and style)
- **Languages**: (primary communication languages)
- **Behavioral Rules**: (specific behavioral constraints)
`;

const USER_TEMPLATE = `# USER.md - User Profile

- **Name**: (user's name)
- **Role**: (profession/role)
- **Technical Stack**: (languages, frameworks, tools)
- **Location**: (timezone/location)
- **Communication Style**: (preferred interaction style)
`;

export class BootstrapManager {
  private memoryManager: MemoryManager;

  constructor(memoryManager: MemoryManager) {
    this.memoryManager = memoryManager;
  }

  initialize(): void {
    this.memoryManager.ensureDirectories();
    if (!this.memoryManager.isInitialized()) {
      this.copyTemplates();
    }
  }

  private copyTemplates(): void {
    const bootstrapPath = this.memoryManager.getBootstrapPath();
    this.memoryManager.writeFile(
      bootstrapPath,
      BOOTSTRAP_TEMPLATE(bootstrapPath)
    );
    this.memoryManager.writeFile(
      this.memoryManager.getMemoryPath(),
      MEMORY_TEMPLATE
    );
    this.memoryManager.writeFile(
      this.memoryManager.getIdentityPath(),
      IDENTITY_TEMPLATE
    );
    this.memoryManager.writeFile(
      this.memoryManager.getUserPath(),
      USER_TEMPLATE
    );
  }

  createProjectTemplates(projectName: string): void {
    this.memoryManager.ensureProjectFolder(projectName);
    const projectPath = this.memoryManager.getProjectPath(projectName);
    const correctionsPath = this.memoryManager.getCorrectionsPath(projectName);
    const environmentPath = this.memoryManager.getEnvironmentPath(projectName);

    // Only create templates if files don't exist
    if (!this.memoryManager.fileExists(projectPath)) {
      this.memoryManager.writeFile(projectPath, PROJECT_TEMPLATE);
    }
    if (!this.memoryManager.fileExists(correctionsPath)) {
      this.memoryManager.writeFile(correctionsPath, CORRECTIONS_TEMPLATE);
    }
    if (!this.memoryManager.fileExists(environmentPath)) {
      this.memoryManager.writeFile(environmentPath, ENVIRONMENT_TEMPLATE);
    }
  }

  isBootstrapNeeded(): boolean {
    return this.memoryManager.needsBootstrap();
  }
}
