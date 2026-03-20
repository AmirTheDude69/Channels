import { describe, expect, it } from 'vitest';
import { createProjectId } from '@channels/shared';

describe('project ids', () => {
  it('creates stable ids from path + name', () => {
    expect(createProjectId('Channels', '/Users/amir/Downloads/Channels')).toMatch(/^channels-/);
  });
});
