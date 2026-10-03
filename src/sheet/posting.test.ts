// posting.ts — the useCreatePostFromApp error contract mapped to UI actions.
// The load-bearing cases: `declined` must stay silent (the viewer chose to
// dismiss), and `timedOut` must win over `.message` (timeout messages are
// SDK-internal; the post may exist — never send the viewer to retry blindly).

import { describe, expect, it } from 'vitest';

import {
  POSTS_SCOPE,
  createPostErrorCopy,
  hasPostsScope,
  isScopeShapedPostError,
} from './posting.js';

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

describe('posts scope helpers', () => {
  it('hasPostsScope checks the token scope list', () => {
    expect(POSTS_SCOPE).toBe('posts:write:self');
    expect(hasPostsScope(['ai:write:budgeted', 'posts:write:self'])).toBe(true);
    expect(hasPostsScope(['ai:write:budgeted'])).toBe(false);
    expect(hasPostsScope([])).toBe(false);
    expect(hasPostsScope(undefined)).toBe(false);
    expect(hasPostsScope(null)).toBe(false);
  });

  it('isScopeShapedPostError catches grant failures, not other errors', () => {
    expect(isScopeShapedPostError({ code: 'no block token' })).toBe(true);
    expect(
      isScopeShapedPostError({ message: 'posts:write:self scope not granted' }),
    ).toBe(true);
    expect(isScopeShapedPostError({ message: '403 Forbidden' })).toBe(true);
    expect(isScopeShapedPostError({ message: 'Permission denied for this user' })).toBe(
      true,
    );
    // Ordinary failures are NOT scope-shaped.
    expect(isScopeShapedPostError({ code: 'declined', declined: true })).toBe(false);
    expect(isScopeShapedPostError({ code: 'no images to post' })).toBe(false);
    expect(isScopeShapedPostError({ message: 'Post service unavailable' })).toBe(false);
    expect(isScopeShapedPostError({ timedOut: true, message: 'GENERATION_TIMEOUT' })).toBe(
      false,
    );
    expect(isScopeShapedPostError({})).toBe(false);
  });
});
