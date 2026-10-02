/** Terminable matcher; no regex execution occurs on the harness event loop. */
import { Worker } from "node:worker_threads";
import { toolRevision } from "../../lib/tool-runtime.js";
const { checkReadState, ReadBudgetError } = await import(`./fs.js?revision=${toolRevision()}`);

export async function matchSearch(text, search, state) {
  checkReadState(state);
  const url = new URL(`./search-worker.js?revision=${toolRevision()}`, import.meta.url);
  const worker = new Worker(url);
  let timer;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(state.signal.reason ?? new Error("read cancelled"));
      state.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new ReadBudgetError("Search time budget exhausted")),
        Math.max(1, Math.min(state.budgets.regexMs, state.deadline - Date.now())));
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`Search worker exited (${code})`)); });
      worker.once("message", ({ value, error }) => error ? reject(new ReadBudgetError(error)) : resolve(value));
      worker.postMessage({ text, search });
      if (state.signal?.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    state.signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
