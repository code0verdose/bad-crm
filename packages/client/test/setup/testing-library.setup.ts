import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * One mounted tree per test.
 *
 * Without this, `render` leaves the previous tree in the document and `getByRole` starts matching
 * two elements — a failure that reads as a bug in the component under test rather than as leaked
 * state from the test before it.
 */
afterEach(() => {
  cleanup();
});
