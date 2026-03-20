import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config.js';
import { buildCodexUiRefreshCommands, refreshCodexDesktopThread, resolveCodexUiRefreshSettings } from '../src/ui-refresh.js';

const originalEnv = {
  CHANNELS_CODEX_UI_REFRESH: env.CHANNELS_CODEX_UI_REFRESH,
  CHANNELS_CODEX_UI_REFRESH_STRATEGY: env.CHANNELS_CODEX_UI_REFRESH_STRATEGY,
  CHANNELS_CODEX_UI_REFRESH_OPEN_WHEN_CLOSED: env.CHANNELS_CODEX_UI_REFRESH_OPEN_WHEN_CLOSED,
};

afterEach(() => {
  env.CHANNELS_CODEX_UI_REFRESH = originalEnv.CHANNELS_CODEX_UI_REFRESH;
  env.CHANNELS_CODEX_UI_REFRESH_STRATEGY = originalEnv.CHANNELS_CODEX_UI_REFRESH_STRATEGY;
  env.CHANNELS_CODEX_UI_REFRESH_OPEN_WHEN_CLOSED = originalEnv.CHANNELS_CODEX_UI_REFRESH_OPEN_WHEN_CLOSED;
});

describe('resolveCodexUiRefreshSettings', () => {
  it('defaults to a disabled helper', () => {
    env.CHANNELS_CODEX_UI_REFRESH = undefined;
    env.CHANNELS_CODEX_UI_REFRESH_STRATEGY = undefined;
    env.CHANNELS_CODEX_UI_REFRESH_OPEN_WHEN_CLOSED = undefined;

    expect(resolveCodexUiRefreshSettings({})).toEqual({
      enabled: false,
      strategy: 'deeplink-activate',
      openWhenClosed: false,
    });
  });

  it('lets env vars override stored config', () => {
    env.CHANNELS_CODEX_UI_REFRESH = 'true';
    env.CHANNELS_CODEX_UI_REFRESH_STRATEGY = 'deeplink';
    env.CHANNELS_CODEX_UI_REFRESH_OPEN_WHEN_CLOSED = '1';

    expect(resolveCodexUiRefreshSettings({
      codexUiRefreshEnabled: false,
      codexUiRefreshStrategy: 'applescript',
      codexUiRefreshOpenWhenClosed: false,
    })).toEqual({
      enabled: true,
      strategy: 'deeplink',
      openWhenClosed: true,
    });
  });
});

describe('buildCodexUiRefreshCommands', () => {
  it('builds the foreground deep-link strategy', () => {
    expect(buildCodexUiRefreshCommands('thread-123', 'deeplink-activate')).toEqual([
      { file: 'open', args: ['-b', 'com.openai.codex', 'codex://threads/thread-123'] },
      { file: 'osascript', args: ['-e', 'tell application id "com.openai.codex" to activate'] },
    ]);
  });
});

describe('refreshCodexDesktopThread', () => {
  it('skips when Codex is closed and the helper is not allowed to launch it', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runCommand = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: 'false\n', stderr: '' };
    };

    await expect(refreshCodexDesktopThread('thread-123', {
      enabled: true,
      strategy: 'deeplink-activate',
      openWhenClosed: false,
    }, runCommand)).resolves.toBe('skipped-not-running');

    expect(calls).toEqual([
      { file: 'osascript', args: ['-e', 'application id "com.openai.codex" is running'] },
    ]);
  });

  it('runs the helper commands when Codex is already open', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runCommand = async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'osascript' && args[1] === 'application id "com.openai.codex" is running') {
        return { stdout: 'true\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    await expect(refreshCodexDesktopThread('thread-123', {
      enabled: true,
      strategy: 'deeplink-activate',
      openWhenClosed: false,
    }, runCommand)).resolves.toBe('refreshed');

    expect(calls).toEqual([
      { file: 'osascript', args: ['-e', 'application id "com.openai.codex" is running'] },
      { file: 'open', args: ['-b', 'com.openai.codex', 'codex://threads/thread-123'] },
      { file: 'osascript', args: ['-e', 'tell application id "com.openai.codex" to activate'] },
    ]);
  });

  it('ignores optional AppleScript focus errors after the main refresh succeeds', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runCommand = async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'osascript' && args[1]?.includes('System Events')) {
        throw new Error('Accessibility not granted');
      }
      return { stdout: '', stderr: '' };
    };

    await expect(refreshCodexDesktopThread('thread-123', {
      enabled: true,
      strategy: 'applescript',
      openWhenClosed: true,
    }, runCommand)).resolves.toBe('refreshed');

    expect(calls).toEqual([
      {
        file: 'osascript',
        args: [
          '-e',
          'open location "codex://threads/thread-123"',
          '-e',
          'tell application id "com.openai.codex" to activate',
          '-e',
          'delay 0.2',
        ],
      },
      {
        file: 'osascript',
        args: ['-e', 'tell application "System Events" to tell process "Codex" to set frontmost to true'],
      },
    ]);
  });
});
