---
name: programming-javascript
description: "This skill should be used when writing, reviewing, or refactoring JavaScript or TypeScript code for Node, Bun or other runtimes: language idioms, async correctness, TypeScript strictness, performance, and untrusted-input safety; not browser DOM/CSS or MCP protocol specifics."
---

# Programming JavaScript

## Language

- Write ESM with named exports. `const` by default, `let` only for reassignment, never `var`.
- End statements with explicit `;`; never rely on automatic semicolon insertion.
- Compare with `===`/`!==`. Use `?.` and `??` for absent values; `||` also replaces `0`, `''` and `false`.
- Numbers are doubles: integers are exact only up to `Number.MAX_SAFE_INTEGER`; use `BigInt` beyond, and never compare money or fractions with raw float `===`.
- Iterate arrays with `for...of` or array methods, never `for...in`.
- Use arrow functions for callbacks, named function declarations at top level; use `#private` fields for class privacy.
- Naming: `camelCase` values and functions, `PascalCase` classes and types, `SCREAMING_SNAKE_CASE` true constants, `is`/`has`/`can` booleans.
- Take several optional settings as one options object with destructured defaults: `function createBuffer({ capacity = 64, grow = true } = {})`. Keep required arguments positional.
- Document public APIs with JSDoc: exact parameters, defaults, return value, thrown errors, and whether inputs are mutated or retained.

## Async and Resources

- Use `async`/`await`; do not mix `.then()` chains into the same function.
- Await or explicitly handle every promise; a floating promise loses its rejection.
- Use `Promise.all` for independent work, `Promise.allSettled` when partial failure is acceptable; bound concurrency for large batches.
- Never block the event loop with synchronous I/O or long CPU loops on a request path; yield periodically (`setImmediate`, `scheduler.yield()`) or move work to a worker.
- Give every resource (handle, stream, timer, listener, `AbortController`) one owner and one release path; release in `finally`. Pair `open` with `close`; make `close` safe to call twice.
- Validate external input once at the module boundary; trust it internally afterwards.

## TypeScript

- Enable `strict`. Never use `any`; take `unknown` and narrow. Give public functions explicit return types.
- Use `interface` for extensible object shapes, `type` for unions and intersections; use string-literal unions for modes.

## Performance

- Keep object shapes stable: initialize every field in the constructor in a fixed order; never add or `delete` properties later (assign `undefined`).
- Keep hot call sites monomorphic: same argument types and shapes every call; keep arrays homogeneous.
- Hoist loop-invariant checks out of hot loops. Keep iterator state minimal without rescanning.
- Use typed arrays for bulk numeric data; transfer or share `ArrayBuffer`s with workers instead of copying.
- Closures retain everything they capture: extract the needed values before creating long-lived callbacks. Drop references, listeners, intervals and subscriptions when done.

## Untrusted Input

- Never pass user input to `eval`, `new Function`, string timers, `vm` or dynamic `import()`; dispatch through an allowlisted object instead.
- Run processes with `execFile`/`spawn(file, args)`, never `exec` with an interpolated string.
- Merge or set untrusted keys only through an allowlist; reject `__proto__`, `constructor`, `prototype`; use `Map` or `Object.create(null)` for dictionaries.
- Avoid nested or overlapping regex quantifiers (`(a+)+`) on user input; cap input length; never compile user-supplied patterns without a linear-time engine.
- Generate tokens, IDs and OTPs with `crypto.randomBytes`/`randomInt`/`getRandomValues`, never `Math.random`.
- Contain paths by canonicalizing both sides with `fs.realpath`, then reject when `path.relative(base, target)` is absolute or starts with `..`. String-prefix checks on `path.resolve` are not symlink-safe.

## Testing

- Use the runtime's test runner (`bun test`, `node --test`); name tests as behavior sentences; arrange, act, assert.
- Mock only at boundaries. Test failure paths by injecting failing dependencies.
