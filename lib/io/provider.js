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
 * Create or retrieve the wire-completed connection class for a provider class.
 * The completed class inherits the provider implementation, supplies OpenAI
 * defaults for missing wire methods, and is cached by provider class identity.
 * @param {Function} Protocol Provider class registered by Env; must be a class
 *   with a prototype suitable for subclassing.
 * @returns {Function} The completed subclass (the original class name is retained).
 * @throws {TypeError} If Protocol cannot be used as a WeakMap key or superclass,
 *   or if its prototype cannot be inspected/extended.
 * @effects May invoke provider code only when an instance is constructed or its
 *   methods are called; caches the completed class in a module-local WeakMap.
 */
export function providerComplete(Protocol) {
  const cached = completed.get(Protocol);
  if (cached) return cached;
  const own = Protocol.prototype;
  const { send: ownSend, classifyError: ownClassify, depletionError: ownDepletion } = own;
  const Completed = class extends Protocol {
    /**
     * Construct a provider connection and initialize its OpenAI-compatible wire fields.
     * @param {string|null|undefined} url Base URL passed to the provider and OpenAI
     *   initializer; a missing value uses the initializer's OpenAI default unless
     *   the provider constructor sets `baseUrl` itself.
     * @param {object} aiio IO instance passed to the provider and used to fill
     *   `connection.aiio` when absent.
     * @returns {void}
     * @throws Propagates errors from the provider constructor or OpenAI initialization.
     * @effects May mutate the connection's `aiio`, `baseUrl`, and `url` fields.
     */
    constructor(url, aiio) {
      super(url, aiio);
      openai.initializeOpenAI(this, url, aiio);
    }

    /**
     * Send a provider message using its implementation or the OpenAI wire default.
     * @param {*} message Provider request message passed to `send` unchanged.
     * @returns {*} The provider send result, or the OpenAI default send result;
     *   the default is a Promise for the transport response.
     * @throws Propagates synchronous errors from the selected send implementation;
     *   Promise rejections from asynchronous implementations propagate to the caller.
     * @effects The provider implementation receives a `base(next)` callback that
     *   sends through the plain HTTP transport; the OpenAI fallback may perform HTTP I/O.
     */
    send(message) {
      return typeof ownSend === "function"
        ? ownSend.call(this, message, (next) => defaultSend(this, next))
        : openai.send.call(this, message);
    }

    /**
     * Classify a thrown value, allowing the provider to refine the shared verdict.
     * @param {*} err Raw thrown value to classify.
     * @returns {ProviderError} The base classification or the provider's returned
     *   verdict normalized to a ProviderError; an existing ProviderError is retained.
     * @throws Propagates errors from the shared classifier, provider classifier,
     *   verdict inspection, or normalization.
     * @effects Calls the provider's `classifyError(err, base)` when it is a function.
     */
    classifyError(err) {
      const base = classifyError(err, this.aiio?.name);
      if (typeof ownClassify !== "function") return base;
      const verdict = ownClassify.call(this, err, base) ?? base;
      return verdict instanceof ProviderError ? verdict : classifyError(verdict, this.aiio?.name);
    }

    /**
     * Decide whether a classified error indicates provider token/quota depletion.
     * @param {*} classified Classified error/event passed to the shared predicate
     *   and, when present, the provider override.
     * @returns {boolean} The shared depletion verdict, or whether the provider
     *   override returns exactly `true`.
     * @throws Propagates errors from the shared predicate or provider override.
     * @effects Calls the provider's `depletionError(classified, base)` when it is a function.
     */
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
