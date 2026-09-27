/**
 * lib/io/provider.js — instance-side provider completion (private to
 * IO). A provider class Env registered carries its static catalog side;
 * IO completes the wire side before constructing a connection:
 *
 *   - missing context2msg / msg2events / read / close / reportPlanUsage
 *     come from the OpenAI Responses defaults (lib/io/openai.js);
 *   - send(msg, base): a provider's own send receives `base`, the
 *     plain HTTP transport, to wrap (missing: the OpenAI default send);
 *   - classifyError(err, base) / depletionError(classified, base):
 *     `base` is the shared verdict a provider may refine.
 *
 * One completed class per provider class (cached).
 */

import * as openai from "./openai.js";
import { defaultSend } from "./http.js";
import { ProviderError, classifyError, depletionError } from "./provider-error.js";

const DEFAULTS = ["context2msg", "msg2events", "read", "close", "reportPlanUsage"];
const completed = new WeakMap();

/**
 * The wire-completed connection class for one provider class.
 * @param {Function} Protocol - the provider class Env registered
 * @returns {Function}
 */
export function providerComplete(Protocol) {
  const cached = completed.get(Protocol);
  if (cached) return cached;
  const own = Protocol.prototype;
  const { send: ownSend, classifyError: ownClassify, depletionError: ownDepletion } = own;
  const Completed = class extends Protocol {
    constructor(url, aiio) {
      super(url, aiio);
      openai.initializeOpenAI(this, url, aiio);
    }

    send(message) {
      return typeof ownSend === "function"
        ? ownSend.call(this, message, (next) => defaultSend(this, next))
        : openai.send.call(this, message);
    }

    classifyError(err) {
      const base = classifyError(err, this.aiio?.name);
      if (typeof ownClassify !== "function") return base;
      const verdict = ownClassify.call(this, err, base) ?? base;
      return verdict instanceof ProviderError ? verdict : classifyError(verdict, this.aiio?.name);
    }

    depletionError(classified) {
      const base = depletionError(classified);
      return typeof ownDepletion === "function" ? ownDepletion.call(this, classified, base) === true : base;
    }
  };
  for (const method of DEFAULTS) {
    if (typeof own[method] === "function") continue;
    Object.defineProperty(Completed.prototype, method, { value: openai[method], writable: true, configurable: true });
  }
  Object.defineProperty(Completed, "name", { value: Protocol.name });
  completed.set(Protocol, Completed);
  return Completed;
}
