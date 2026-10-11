export interface Issue {
  level: 'error' | 'warning';
  pack: string;
  file?: string;
  doc?: number;
  path: string;
  message: string;
}

export function formatIssue(i: Issue): string {
  const where = [i.file ? `${i.file}${i.doc !== undefined ? `#${i.doc}` : ''}` : '', i.path].filter(Boolean).join(' ');
  return `${i.level}: [${i.pack}] ${where ? `${where}: ` : ''}${i.message}`;
}

export class ValidationError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`Validation failed:\n${issues.map(formatIssue).join('\n')}`);
    this.name = 'ValidationError';
  }
}

/** A viewer-facing refusal. The command is rejected and the game state is unchanged. */
export class Rejection extends Error {
  constructor(message: string, readonly code: string = 'rejected') {
    super(message);
    this.name = 'Rejection';
  }
}

/** Any other throw from pack code, tagged with where it came from. */
export class PluginError extends Error {
  constructor(readonly pack: string, readonly plugin: string, override readonly cause: unknown) {
    super(`Error in ${plugin} (pack ${pack}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PluginError';
  }
}

/** An engine-level refusal with a stable code, e.g. 'content-in-use'. */
export class EngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
