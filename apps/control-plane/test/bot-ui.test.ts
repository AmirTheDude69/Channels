import { describe, expect, it } from 'vitest';
import { formatThreadList, rootKeyboard, threadKeyboard } from '../src/telegram-ui.js';
import { applyThreadSelection, canRunTurn } from '../src/bot.js';

describe('telegram ui', () => {
  it('renders root keyboard', () => {
    expect(rootKeyboard().inline_keyboard.length).toBeGreaterThan(1);
  });

  it('renders thread list markers', () => {
    expect(
      formatThreadList(
        [
          {
            threadId: 'thr_1',
            title: 'Alpha',
            cwd: '/tmp',
            updatedAt: 1,
            archived: false,
            projectId: 'p1',
            legacy: false,
            preview: '',
          },
        ],
        'thr_1',
      ),
    ).toContain('◀ Alpha');
  });

  it('creates thread action keyboard', () => {
    expect(
      threadKeyboard({
        threadId: 'thr_1',
        title: 'Alpha',
        cwd: '/tmp',
        updatedAt: 1,
        archived: false,
        projectId: 'p1',
        legacy: false,
        preview: '',
      }).inline_keyboard.flat().map((item) => item.text),
    ).toContain('Fork');
  });

  it('lets legacy thread selections run without a project', () => {
    const session = { activeProjectId: 'project-1', activeThreadId: null as string | null };
    applyThreadSelection(
      session,
      {
        threadId: 'thr_legacy',
        title: 'Legacy thread',
        cwd: '/tmp',
        updatedAt: 1,
        archived: false,
        projectId: null,
        legacy: true,
        preview: '',
      },
      'thr_legacy',
    );

    expect(session.activeProjectId).toBeNull();
    expect(session.activeThreadId).toBe('thr_legacy');
    expect(canRunTurn(session)).toBe(true);
  });

  it('syncs project context from non-legacy thread selections', () => {
    const session = { activeProjectId: null as string | null, activeThreadId: null as string | null };
    applyThreadSelection(
      session,
      {
        threadId: 'thr_project',
        title: 'Project thread',
        cwd: '/tmp',
        updatedAt: 1,
        archived: false,
        projectId: 'project-2',
        legacy: false,
        preview: '',
      },
      'thr_project',
    );

    expect(session.activeProjectId).toBe('project-2');
    expect(session.activeThreadId).toBe('thr_project');
    expect(canRunTurn(session)).toBe(true);
  });
});
