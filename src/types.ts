export interface ModelRef {
  provider: string;
  id: string;
}

export interface ChangedFile {
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath?: string;
}

export interface ChangeGroup {
  label: string;
  path?: string;
  files: ChangedFile[];
  context: string;
  truncated: boolean;
}

export interface CommitSuggestion {
  label: string;
  message: string;
}
