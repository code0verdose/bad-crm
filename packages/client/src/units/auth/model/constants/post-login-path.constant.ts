/**
 * Where a session lands when nothing else says otherwise: the fallback after a sign-in whose URL
 * carried no safe `redirect`, and the destination `redirectIfAuthed` sends an already-authenticated
 * visitor to when they open the login form.
 *
 * One constant rather than a literal in each of those places, because they are one product decision
 * — and a literal repeated twice is a decision that changes in one place only.
 */
export const POST_LOGIN_PATH = '/dashboard';
