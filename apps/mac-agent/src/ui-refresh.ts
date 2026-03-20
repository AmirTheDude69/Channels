import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { env } from './config.js';

const execFileAsync = promisify(execFile);
const codexBundleId = 'com.openai.codex';
const codexApplicationName = 'Codex';

export const codexUiRefreshStrategyValues = ['deeplink', 'deeplink-activate', 'applescript'] as const;
export const codexUiRefreshStrategySchema = z.enum(codexUiRefreshStrategyValues);

export type CodexUiRefreshStrategy = z.infer<typeof codexUiRefreshStrategySchema>;
export type CodexUiRefreshSettings = {
  enabled: boolean;
  strategy: CodexUiRefreshStrategy;
  openWhenClosed: boolean;
};

type StoredCodexUiRefreshSettings = {
  codexUiRefreshEnabled?: boolean;
  codexUiRefreshStrategy?: CodexUiRefreshStrategy;
  codexUiRefreshOpenWhenClosed?: boolean;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

type CommandSpec = {
  file: string;
  args: string[];
  optional?: boolean;
};

const defaultRunner: CommandRunner = async (file, args) => {
  const result = await execFileAsync(file, args);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export function resolveCodexUiRefreshSettings(stored: StoredCodexUiRefreshSettings): CodexUiRefreshSettings {
  return {
    enabled: coerceOptionalBoolean(env.CHANNELS_CODEX_UI_REFRESH) ?? stored.codexUiRefreshEnabled ?? false,
    strategy: resolveStrategy(env.CHANNELS_CODEX_UI_REFRESH_STRATEGY, stored.codexUiRefreshStrategy),
    openWhenClosed: coerceOptionalBoolean(env.CHANNELS_CODEX_UI_REFRESH_OPEN_WHEN_CLOSED) ?? stored.codexUiRefreshOpenWhenClosed ?? false,
  };
}

export function buildCodexUiRefreshCommands(threadId: string, strategy: CodexUiRefreshStrategy): CommandSpec[] {
  const threadUrl = `codex://threads/${encodeURIComponent(threadId)}`;
  switch (strategy) {
    case 'deeplink':
      return [
        { file: 'open', args: ['-g', '-b', codexBundleId, threadUrl] },
      ];
    case 'deeplink-activate':
      return [
        { file: 'open', args: ['-b', codexBundleId, threadUrl] },
        { file: 'osascript', args: ['-e', `tell application id "${codexBundleId}" to activate`] },
      ];
    case 'applescript':
      return [
        {
          file: 'osascript',
          args: [
            '-e', `open location ${quoteAppleScriptString(threadUrl)}`,
            '-e', `tell application id "${codexBundleId}" to activate`,
            '-e', 'delay 0.2',
          ],
        },
        {
          file: 'osascript',
          args: ['-e', `tell application "System Events" to tell process "${codexApplicationName}" to set frontmost to true`],
          optional: true,
        },
      ];
  }
}

export async function isCodexDesktopRunning(runCommand: CommandRunner = defaultRunner): Promise<boolean> {
  const result = await runCommand('osascript', ['-e', `application id "${codexBundleId}" is running`]);
  return result.stdout.trim() === 'true';
}

export async function refreshCodexDesktopThread(
  threadId: string,
  settings: CodexUiRefreshSettings,
  runCommand: CommandRunner = defaultRunner,
): Promise<'disabled' | 'skipped-not-running' | 'refreshed'> {
  if (!settings.enabled) {
    return 'disabled';
  }

  if (!settings.openWhenClosed) {
    const running = await isCodexDesktopRunning(runCommand).catch(() => false);
    if (!running) {
      return 'skipped-not-running';
    }
  }

  for (const command of buildCodexUiRefreshCommands(threadId, settings.strategy)) {
    try {
      await runCommand(command.file, command.args);
    } catch (error) {
      if (!command.optional) {
        throw error;
      }
    }
  }

  return 'refreshed';
}

function coerceOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value for Codex UI refresh setting: ${value}`);
}

function resolveStrategy(rawValue: string | undefined, storedValue: CodexUiRefreshStrategy | undefined): CodexUiRefreshStrategy {
  if (rawValue) {
    return codexUiRefreshStrategySchema.parse(rawValue);
  }
  return storedValue ?? 'deeplink-activate';
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
