// Cancel a navigation that the server never answers, so the page it was
// leaving stays usable. Best effort: callers report the page as not responding
// whether or not the cancel worked.
export async function stopPendingNavigation(page) {
  let session = null;
  try {
    session = await page.context().newCDPSession(page);
    await Promise.race([
      session.send('Page.stopLoading'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stopLoading timed out')), 3000))
    ]);
    return true;
  } catch {
    return false;
  } finally {
    await session?.detach().catch(() => {});
  }
}
