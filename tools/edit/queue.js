// Serialize read/validate/write across edit, edit-undo and splice in this process.
const queues = new Map();

export async function queueEdit(resolved, task) {
  const previous = queues.get(resolved);
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  queues.set(resolved, current);
  if (previous) await previous;
  try {
    return await task();
  } finally {
    release();
    if (queues.get(resolved) === current) queues.delete(resolved);
  }
}
