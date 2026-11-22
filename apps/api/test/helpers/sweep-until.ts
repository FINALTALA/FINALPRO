/**
 * TB-11: a sweep item takes its row FOR UPDATE SKIP LOCKED, so a sweep
 * leaves alone a row another API instance is working on - and in a
 * parallel e2e run every test file is its own app instance on the same
 * database, each sweeping every due row. The instance holding the row
 * finishes it a moment later; a test that asserts one row's outcome
 * after a sweep therefore sweeps until that row has settled (the
 * assertions that follow still decide pass or fail). Never throws.
 */
export async function sweepUntil(
  sweepOnce: () => Promise<unknown>,
  settled: () => Promise<boolean>,
  attempts = 20,
  pauseMs = 250,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await sweepOnce();
    if (await settled()) return;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
}
