export function codexResumeCommand(input: { codexThreadId: string; projectPath: string }): string {
  return `codex resume -C ${shellQuote(input.projectPath)} ${shellQuote(input.codexThreadId)}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
