// Private, temporary compressed CPU audio. OPFS avoids keeping a 10-hour
// recording in RAM. A bounded in-memory LRU is used if disk storage is denied.
export async function createAudioBatchStore({ diskBytes = 512 * 1024 * 1024, memoryBytes = 64 * 1024 * 1024 } = {}) {
  let directory = null, root = null;
  const name = `cpu-audio-${crypto.randomUUID()}`;
  try {
    root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle(name, { create: true });
  } catch {}
  const limit = directory ? diskBytes : memoryBytes;
  const entries = new Map();
  let size = 0, closed = false;
  async function remove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id); size -= entry.size;
    if (directory) await directory.removeEntry(id).catch(() => {});
  }
  return {
    has(id) { return entries.has(id); },
    pin(id) { const entry = entries.get(id); if (entry) entry.pins++; },
    unpin(id) { const entry = entries.get(id); if (entry) entry.pins = Math.max(0, entry.pins - 1); },
    async put(id, blob) {
      if (closed || blob.size > limit) throw new Error('CPU audio batch cache limit exceeded');
      while (size + blob.size > limit && entries.size) {
        const candidate = [...entries].find(([, entry]) => !entry.pins);
        if (!candidate) throw new Error('CPU audio cache is busy; retry this batch later');
        await remove(candidate[0]);
      }
      if (directory) {
        const file = await directory.getFileHandle(id, { create: true });
        const writer = await file.createWritable();
        try { await writer.write(blob); await writer.close(); }
        catch (error) { await writer.abort().catch(() => {}); await directory.removeEntry(id).catch(() => {}); throw error; }
      }
      entries.set(id, { size: blob.size, blob: directory ? null : blob, pins: 0 }); size += blob.size;
    },
    async get(id) {
      const entry = entries.get(id);
      if (!entry || closed) throw new Error('CPU audio batch is no longer cached');
      entries.delete(id); entries.set(id, entry);
      return directory ? (await directory.getFileHandle(id)).getFile() : entry.blob;
    },
    async close() {
      closed = true; entries.clear(); size = 0;
      // Only remove this source's own UUID directory, never other origin data.
      if (directory) await root.removeEntry(name, { recursive: true }).catch(() => {});
    },
  };
}
