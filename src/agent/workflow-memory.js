export function createWorkflowMemory() {
  const records = [];
  const visited = new Set();

  return {
    add(record) {
      if (!record?.url) {
        throw new Error("Record must contain a URL.");
      }

      if (visited.has(record.url)) {
        return false;
      }

      visited.add(record.url);
      records.push({ ...record });

      return true;
    },

    getAll() {
      return records.map(record => ({ ...record }));
    },

    count() {
      return records.length;
    },

    hasVisited(url) {
      return visited.has(url);
    }
  };
}
