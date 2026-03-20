import { describe, expect, it } from 'vitest';
import { buildForumTopicTitle, formatForumPromptMirror, formatForumTranscriptEntry } from '../src/forum-mirror.js';

describe('forum mirror helpers', () => {
  it('builds compact topic titles with project prefixes', () => {
    expect(buildForumTopicTitle('Channels', 'Build Telegram controls for Codex')).toBe('Channels · Build Telegram controls for Codex');
  });

  it('truncates oversized topic titles', () => {
    expect(buildForumTopicTitle('WishGalaxy', 'x'.repeat(200)).length).toBeLessThanOrEqual(120);
  });

  it('formats mirrored user prompts with transcriptions and attachments', () => {
    const chunks = formatForumPromptMirror({
      prompt: 'Please inspect this image.',
      transcribedText: 'Voice note transcript',
      attachmentNames: ['image-1.png'],
      originLabel: 'from command center',
    });

    expect(chunks.join('\n\n')).toContain('Voice note');
    expect(chunks.join('\n\n')).toContain('image-1.png');
    expect(chunks.join('\n\n')).toContain('from command center');
  });

  it('formats assistant transcript entries for topic mirroring', () => {
    const chunks = formatForumTranscriptEntry({
      role: 'assistant',
      text: '## Done\n\n- Updated the bot',
    });

    expect(chunks.join('\n\n')).toContain('<b>Codex</b>');
    expect(chunks.join('\n\n')).toContain('Updated the bot');
  });
});
