/**
 * The session states a test may put the router in.
 *
 * Spelled here rather than imported from the unit so that the fixture keeps compiling if the unit's
 * own type gains a state — at which point the mismatch is a compile error in one place, which is
 * the moment to decide what the guards should do with it.
 */
export type SessionStatusFixture = 'unknown' | 'anonymous' | 'authenticated';
