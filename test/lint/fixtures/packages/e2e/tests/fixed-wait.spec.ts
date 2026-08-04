/** Waits by the clock instead of by the state it needs — the flake that fails only on a busy CI. */
export const openBoard = async (page: { waitForTimeout: (ms: number) => Promise<void> }) => {
  await page.waitForTimeout(1000);
};
