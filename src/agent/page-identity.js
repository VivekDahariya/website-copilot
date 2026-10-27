const pageIds = new WeakMap();
let nextId = 0;

export function getPageId(page) {
  if (!page || typeof page.url !== "function") {
    return null;
  }

  let id = pageIds.get(page);

  if (!id) {
    id = `tab-${++nextId}`;
    pageIds.set(page, id);
  }

  return id;
}
