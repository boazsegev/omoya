/** One lazily owned, terminable matcher per query; regex never runs on the harness event loop. */
import { Worker } from "node:worker_threads";
import { toolRevision } from "../../lib/tool-runtime.js";
const { checkReadState, ReadBudgetError } = await import(`./fs.js?revision=${toolRevision()}`);

function searchWorker(state) {
  if (!state.searchWorker) {
    const url = new URL(`./search-worker.js?revision=${toolRevision()}`, import.meta.url);
    state.searchWorker = new Worker(url);
  }
  return state.searchWorker;
}

/** Sequential searches share startup cost; execution/cancellation budget is renewed per file. */
export async function matchSearch(text, search, state) {
  checkReadState(state);
  const worker = searchWorker(state);
  let timer;
  let abort;
  let fail;
  let exited;
  let message;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(state.signal.reason ?? new Error("read cancelled"));
      fail = reject;
      exited = (code) => reject(new Error(`Search worker exited (${code})`));
      message = ({ value, error }) => error ? reject(new ReadBudgetError(error)) : resolve(value);
      state.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new ReadBudgetError("Search time budget exhausted")),
        Math.max(1, Math.min(state.budgets.regexMs, state.deadline - Date.now())));
      worker.once("error", fail);
      worker.once("exit", exited);
      worker.once("message", message);
      worker.postMessage({ text, search });
      if (state.signal?.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    state.signal?.removeEventListener("abort", abort);
    worker.removeListener("error", fail);
    worker.removeListener("exit", exited);
    worker.removeListener("message", message);
  }
}

/** The shared engine owns cleanup on success, limit, budget exhaustion and errors. */
export async function closeSearch(state) {
  const worker = state.searchWorker;
  state.searchWorker = null;
  await worker?.terminate();
}
