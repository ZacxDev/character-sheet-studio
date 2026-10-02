// posting.ts — the useCreatePostFromApp error contract mapped to UI actions.
// The load-bearing cases: `declined` must stay silent (the viewer chose to
// dismiss), and `timedOut` must win over `.message` (timeout messages are
// SDK-internal; the post may exist — never send the viewer to retry blindly).

import { describe, expect, it } from 'vitest';

import { createPostErrorCopy } from './posting.js';

describe('createPostErrorCopy', () => {
  it('stays silent when the viewer declined the host confirm', () => {
    expect(createPostErrorCopy({ declined: true, code: 'declined' })).toEqual({
      action: 'silent',
    });
  });

  it('routes guests to sign-in (flag or host code)', () => {
    expect(createPostErrorCopy({ signInRequired: true })).toEqual({ action: 'sign-in' });
    expect(createPostErrorCopy({ code: 'sign in to post' })).toEqual({ action: 'sign-in' });
  });

  it('timeout wins over the message — check your profile, never retry', () => {
    const copy = createPostErrorCopy({
      timedOut: true,
      message: 'GENERATION_SOURCE_LOOKUP_TIMEOUT internal detail',
    });
    expect(copy.action).toBe('notice');
    if (copy.action === 'notice') {
      expect(copy.message).toContain('check your profile');
      expect(copy.message).not.toContain('internal detail');
    }
  });

  it('maps the closed set of host codes to viewer copy', () => {
    for (const code of [
      'review-mode',
      'block is not ready',
      'no images to post',
      'no block token',
    ]) {
      const copy = createPostErrorCopy({ code });
      expect(copy.action).toBe('notice');
      if (copy.action === 'notice') expect(copy.message.length).toBeGreaterThan(10);
    }
    expect(createPostErrorCopy({ code: 'review-mode' })).toEqual({
      action: 'notice',
      message: expect.stringContaining('review preview'),
    });
  });

  it('passes a safe server message through, else falls back', () => {
    expect(createPostErrorCopy({ message: 'Post service unavailable' })).toEqual({
      action: 'notice',
      message: 'Post service unavailable',
    });
    expect(createPostErrorCopy({})).toEqual({
      action: 'notice',
      message: expect.stringContaining('try again'),
    });
    expect(createPostErrorCopy({ message: '   ' })).toEqual({
      action: 'notice',
      message: expect.stringContaining('try again'),
    });
  });
});
