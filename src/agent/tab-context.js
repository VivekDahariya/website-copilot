export function createTabContext(initialPage) {
  const context = initialPage.context();
  const refs = new WeakMap();
  const pagesByRef = new Map();
  let nextId = 1;

  function refFor(page) {
    if (!refs.has(page)) {
      const ref = `tab_${nextId++}`;
      refs.set(page, ref);
      pagesByRef.set(ref, page);
    }
    return refs.get(page);
  }

  refFor(initialPage);

  async function describe(activePage) {
    return Promise.all(
      context.pages()
        .filter(page => !page.isClosed())
        .map(async page => ({
          ref: refFor(page),
          url: page.url(),
          title: await page.title().catch(() => ""),
          active: page === activePage
        }))
    );
  }

  function resolve(ref) {
    const page = pagesByRef.get(ref);
    return page && !page.isClosed() ? page : null;
  }

  return { describe, resolve };
}
