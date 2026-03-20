import { describe, expect, it } from 'vitest';
import { formatThreadList, rootKeyboard, threadKeyboard } from '../src/telegram-ui.js';

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
});
