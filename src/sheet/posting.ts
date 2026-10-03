// Post-from-app error mapping — the `useCreatePostFromApp` error contract
// (documented in the SDK): the host runs its own confirm before any post
// exists, so each failure class has a prescribed UI response:
//
// - `declined` — the viewer dismissed the host confirm. Nothing happened;
//   saying anything would blame them for a choice they made.
// - `signInRequired` — route to sign-in instead of showing prose.
// - `timedOut` — the write MAY have landed; never auto-retry, tell them to
//   check their profile. Checked BEFORE `.message` (timeout messages are
//   SDK-internal wording, not viewer-safe).
// - host `.code` — a stable code from a closed set; mapped to viewer copy.
// - anything else — `.message` is a server message that is safe to render.
//
// No React, no DOM — unit-tested in node (see posting.test.ts).

/** The structural subset of the SDK's CreatePostError this mapping reads. */
export interface CreatePostErrorLike {
  /** Stable host code (closed set) or null. */
  code?: string | null;
  /** The viewer dismissed the host confirm; no post exists. */
  declined?: boolean;
  /** The viewer is a guest — route to sign-in. */
  signInRequired?: boolean;
  /** The reply was lost; the post may still exist. Never auto-retry. */
  timedOut?: boolean;
  /** Server message, safe to render (except on timeouts). */
  message?: string;
}

/**
 * The consent-gated scope behind posting. It must be declared in the
 * manifest (with a justification) AND granted by the viewer before the host
 * will resolve a createPost — so Post checks for it first and routes a
 * missing grant to the consent prompt instead of an error wall.
 */
export const POSTS_SCOPE = 'posts:write:self';

/** Whether the current block token already carries the posts scope. */
export function hasPostsScope(
  scopes: readonly string[] | undefined | null,
): boolean {
  return Array.isArray(scopes) && scopes.includes(POSTS_SCOPE);
}

const SCOPE_ERROR_RE = /scope|permission|consent|not granted|forbidden|\b403\b/i;

/**
 * Whether a createPost failure smells like a missing posts:write:self grant
 * ('no block token', or a permission-flavored server message). These get ONE
 * consent round-trip + retry, not an error wall; anything else follows the
 * normal copy mapping.
 */
export function isScopeShapedPostError(err: CreatePostErrorLike): boolean {
  if (err.code === 'no block token') return true;
  return typeof err.message === 'string' && SCOPE_ERROR_RE.test(err.message);
}

export type PostOutcomeCopy =
  | { action: 'silent' }
  | { action: 'sign-in' }
  | { action: 'notice'; message: string };

export function createPostErrorCopy(err: CreatePostErrorLike): PostOutcomeCopy {
  if (err.declined) return { action: 'silent' };
  if (err.signInRequired) return { action: 'sign-in' };
  if (err.timedOut) {
    return {
      action: 'notice',
      message:
        'Posting took too long to confirm — check your profile before trying again; the post may already be there.',
    };
  }
  switch (err.code) {
    case 'review-mode':
      return {
        action: 'notice',
        message: 'Posting isn’t available while this app is in review preview.',
      };
    case 'block is not ready':
      return {
        action: 'notice',
        message: 'This app isn’t ready to post yet.',
      };
    case 'sign in to post':
      return { action: 'sign-in' };
    case 'no images to post':
      return {
        action: 'notice',
        message: 'There’s nothing to post — the images may already be in a post.',
      };
    case 'no block token':
      return {
        action: 'notice',
        message: 'Posting isn’t available in this context.',
      };
    default:
      break;
  }
  if (err.message && err.message.trim() !== '') {
    return { action: 'notice', message: err.message };
  }
  return {
    action: 'notice',
    message: 'Posting failed — try again in a moment.',
  };
}
