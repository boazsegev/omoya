/**
 * safe-storage.js — Encrypted key-value store, plain <script> version.
 *
 * Works on file:// and any origin — no ESM imports, no build step. Exposes a
 * single global: SafeStorage. All helpers, connectors, and crypto utilities are
 * static members of the class, so nothing else leaks into the global namespace.
 *
 * Usage:
 *
 *   <script src="safe-storage.js"></script>
 *   <script>
 *     const storage = new SafeStorage({
 *       namespace: "app.example.v1",
 *       secret:    SafeStorage.utf8Secret(location.href),
 *       // or secret: passkeySecret(namespace) for passkeys
 *       // or secret: prompt("Passphrase:") for password protection
 *       // or secret: [newSecret, oldSecret] during rotation
 *       connectors: [new SafeStorage.LocalStorageConnector()],
 *     });
 *
 *     storage.setItem("theme", "dark");
 *     storage.getItem("theme");           // "dark"
 *     storage.removeItem("theme");
 *     storage.clear();
 *
 *     storage.onchange(({ type, key, oldValue, newValue, origin }) => { ... });
 *     storage.onerror((err) => { ... });
 *   </script>
 *
 * Passphrase isolation and rotation:
 *   Different passphrases with the same namespace produce independent keyspaces.
 *   `secret` may be one Uint8Array or an array; index 0 is the primary write
 *   secret, while all secrets are used for reads. Secondary-secret data that
 *   updates memory is re-encrypted under the primary secret.
 *
 * Static members:
 *
 *   Internal helpers (SafeStorage.Base — single definition, exposed for tests)
 *     SafeStorage.Base.utf8Encode / utf8Decode / concatBytes / randomBytes
 *     SafeStorage.Base.createNonce / timestampFromNonce / compareNonces / bumpNonce
 *     SafeStorage.Base.buildValuePayload / buildRemovePayload / validatePayload
 *     SafeStorage.Base.expandSecret / hmacBase64 / aesEncrypt / aesDecrypt
 *     SafeStorage.Base.fanOut
 *     SafeStorage.Base.V1Crypto (version-aware nonce/crypto helpers)
 *     (Not part of the public API; the Store calls these internally.)
 *
 *   Connector utilities (published — third-party connectors rely on these)
 *     SafeStorage.NONCE_BYTES                  → 12
 *     SafeStorage.FORMAT_VERSION               → 1
 *     SafeStorage.compareBytes(a, b)           → -1 | 0 | 1  (stale-write comparison)
 *     SafeStorage.timestampFromNonce(blob)     → number        (extract ms timestamp)
 *     SafeStorage.base64Encode(bytes)          → string        (Uint8Array → base64)
 *     SafeStorage.base64Decode(str)            → Uint8Array    (base64 → Uint8Array)
 *
 *   Secret helpers
 *     SafeStorage.utf8Secret(text)             → Uint8Array
 *       Converts a string to UTF-8 bytes for use as `secret`. It does NOT
 *       hash, stretch, or derive entropy; the Store applies HKDF later.
 *       Intended for debug, minimal protection, or user-supplied passphrases.
 *     SafeStorage.passkeySecret({ namespace }) → Promise<Uint8Array>
 *       Derives a high-entropy secret from a WebAuthn passkey (PRF) or a
 *       fallback passphrase prompt.
 *
 *   Connectors
 *     SafeStorage.SessionStorageConnector       (no-op / memory-only placeholder)
 *     SafeStorage.LocalStorageConnector         (localStorage + cross-tab events)
 *     SafeStorage.IndexedDBConnector            (one object store, direct blobs)
 *     SafeStorage.WebSocketConnector            (tab-delimited text frames)
 *
 * Security limits:
 *   - Protects against casual inspection of at-rest browser storage.
 *   - Does NOT protect against same-origin XSS after the key is loaded, in-page
 *     malicious code, memory inspection, or root key stored beside ciphertext.
 *   - JavaScript cannot guarantee secure memory erasure.
 *   - Clock skew between devices can cause data loss by design.
 */
class SafeStorage {

  // ── Internal helpers — SafeStorage.Base ───────────────────────────────────
  // Single source of truth for byte/nonce/payload/crypto internals and for
  // shared reconciliation side-effects. Not part of the published API; exposed
  // here only so unit tests can reach them. These are pure functions — they
  // never use `this`; peers are called by full name.
  //
  // Version-aware crypto lives under `V1Crypto`. `Base.createNonce`,
  // `Base.timestampFromNonce`, and `Base.compareNonces` are convenience
  // delegates to the current version. A future `V2Crypto` would be selected by
  // inspecting `nonce[0]` and routing through a version map.

  static Base = {
    utf8Encode: (s) => new TextEncoder().encode(s),
    utf8Decode: (b) => new TextDecoder().decode(b),

    concatBytes: (a, b) => {
      const out = new Uint8Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    },

    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),

    // Version-aware nonce/crypto helpers. Only V1 exists today; the layout is
    // versioned so future formats can be routed through `nonce[0]`.
    V1Crypto: {
      NONCE_BYTES: 12,
      TIMESTAMP_BYTES: 6,
      COUNTER_BYTES: 2,
      RANDOM_BYTES: 3,
      TIMESTAMP_MAX: 2 ** 48 - 1,

      // Nonce layout (12 bytes):
      //   byte 0:      formatVersion (uint8)
      //   bytes 1–6:   timestamp_ms lower 48 bits (uint48 big-endian)
      //   bytes 7–8:   local same-ms counter (uint16 big-endian)
      //   bytes 9–11:  random tie-breaker (3 bytes)
      createNonce(timestamp, counter = 0, random = SafeStorage.Base.randomBytes(3)) {
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > this.TIMESTAMP_MAX)
          throw new RangeError("timestamp out of V1 48-bit range");
        if (random.length !== this.RANDOM_BYTES)
          throw new RangeError("random must be " + this.RANDOM_BYTES + " bytes");
        const nonce = new Uint8Array(SafeStorage.NONCE_BYTES);
        nonce[0] = SafeStorage.FORMAT_VERSION;
        const view = new DataView(nonce.buffer);
        view.setUint16(1, Math.floor(timestamp / 2 ** 32));
        view.setUint32(3, timestamp % 2 ** 32);
        view.setUint16(7, counter & 0xffff);
        nonce.set(random, 9);
        return nonce;
      },

      timestampFromNonce(blob) {
        const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        return view.getUint16(1) * 2 ** 32 + view.getUint32(3);
      },

      // Lexicographic nonce comparison, skipping the version byte. All V1
      // nonces share byte 0, so this is equivalent to full-byte comparison for
      // the current version while leaving room for future version routing.
      compareNonces(a, b) {
        const len = Math.min(a.length, b.length);
        for (let i = 1; i < len; i++) {
          if (a[i] < b[i]) return -1;
          if (a[i] > b[i]) return 1;
        }
        return 0;
      },
    },

    // Current-version delegates. Tests and the Store call these; they route to
    // V1Crypto today and will route through a version map if a V2 is added.
    createNonce: (...args) => SafeStorage.Base.V1Crypto.createNonce(...args),
    timestampFromNonce: (blob) => SafeStorage.Base.V1Crypto.timestampFromNonce(blob),
    compareNonces: (a, b) => SafeStorage.Base.V1Crypto.compareNonces(a, b),

    bumpNonce: (nonce) => {
      const next = new Uint8Array(nonce);
      for (let i = next.length - 1; i > 0; i--) {
        next[i] = (next[i] + 1) & 0xff;
        if (next[i] !== 0) return next;
      }
      throw new RangeError("nonce cannot be incremented without changing format version");
    },

    buildValuePayload: (entry) => ({
      key: entry.key, value: entry.value, timestamp: entry.timestamp,
    }),

    validatePayload: (parsed, nonceTimestamp) => {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const keys = new Set(Object.keys(parsed));
      const isSet = keys.size === 3 && keys.has("key") && keys.has("timestamp") && keys.has("value");
      const isRemove = keys.size === 2 && keys.has("key") && keys.has("timestamp");
      if (!isSet && !isRemove) return false;
      if (typeof parsed.key !== "string") return false;
      if (isSet && typeof parsed.value !== "string") return false;
      if (typeof parsed.timestamp !== "number") return false;
      if (!Number.isSafeInteger(parsed.timestamp) || parsed.timestamp < 0) return false;
      if (parsed.timestamp !== nonceTimestamp) return false;
      return true;
    },

    buildRemovePayload: (entry) => ({
      key: entry.key, timestamp: entry.timestamp,
    }),

    expandSecret: async (secret) => {
      const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
      const params = (info) => ({
        name: "HKDF", hash: "SHA-256",
        salt: new Uint8Array(0),
        info: SafeStorage.Base.utf8Encode(info),
      });
      const nameKey = await crypto.subtle.deriveKey(
        params("name"), base,
        { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"],
      );
      const encryptionKey = await crypto.subtle.deriveKey(
        params("enc"), base,
        { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
      );
      return { nameKey, encryptionKey };
    },

    hmacBase64: async (key, data) => {
      const sig = await crypto.subtle.sign("HMAC", key, data);
      return SafeStorage.base64Encode(new Uint8Array(sig));
    },

    aesEncrypt: async (key, nonce, plaintext, aad) => {
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext,
      );
      return new Uint8Array(ct);
    },

    aesDecrypt: async (key, nonce, ciphertext, aad) => {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad }, key, ciphertext,
      );
      return new Uint8Array(pt);
    },

    // Reconciliation fan-out policy. The source connector determines the
    // propagation scope; the emitting connector is always skipped so it never
    // receives an echo of its own write.
    //   source === null          → local API / upload: fan out to all connectors
    //   source.remote === true   → remote transport: fan out to local connectors only
    //   source.remote !== true   → local backend: memory only, no fan out
    fanOut(connectors, source, callback) {
      for (const connector of connectors) {
        if (connector === source) continue;
        if (source === null) {
          callback(connector);
        } else if (source.remote === true && connector.remote !== true) {
          callback(connector);
        }
      }
    },
  };

  // ── Published constants & utilities ───────────────────────────────────────
  // The small surface apps and third-party connectors rely on. Internal-only
  // helpers live under SafeStorage.Base, keeping this namespace lean.

  static NONCE_BYTES = 12;
  static FORMAT_VERSION = 1;

  static base64Encode(bytes) {
    // Native Uint8Array base64 is ~10–100× faster and avoids a temporary
    // binary string. Fall back to btoa for older runtimes.
    if (typeof bytes.toBase64 === "function") return bytes.toBase64();
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  static base64Decode(str) {
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(str);
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Lexicographic byte comparison. Length is NOT a tie-breaker.
  static compareBytes(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  static timestampFromNonce(blob) {
    return SafeStorage.Base.timestampFromNonce(blob);
  }

  // ── Instance state ────────────────────────────────────────────────────────

  #namespace;
  #connectors;
  #removeDelayMs;
  #migrateData;
  #filter;
  #filterNonce = null;
  #lastNow = -1;
  #nonceCounter = 0;
  #entries = new Map();
  #delayedRemoves = new Set();
  #importUnencrypted = undefined; // undefined | true | false
  #removeUnencrypted = undefined;  // undefined | true | false
  #listeners = new Set();
  #errorListeners = new Set();
  #secrets = [];
  #namespaceName = null;
  #keysReady;
  #allReady;

  constructor({ namespace, secret, connectors, filter, removeDelayMs = 30000, migrate = true }) {
    if (!namespace || typeof namespace !== "string")
      throw new Error("namespace is required");
    const initialSecrets = SafeStorage.#normalizeSecrets(secret);
    if (!Array.isArray(connectors) || connectors.length === 0)
      throw new Error("at least one connector is required");

    this.#namespace = namespace;
    this.#connectors = connectors;
    this.#removeDelayMs = removeDelayMs;
    this.#migrateData = migrate;

    if (filter !== undefined) {
      this.#filter = filter;
    } else {
      try {
        const stored = localStorage.getItem(`${namespace}__filter`);
        this.#filter = stored ? Number(stored) : 0;
      } catch {
        this.#filter = 0;
      }
    }

    this.#keysReady = this.#replaceSecrets(initialSecrets);
    this.#allReady = this.#connectAndHydrate();
  }

  static #normalizeSecrets(secret) {
    const secrets = Array.isArray(secret) ? secret : [secret];
    if (secrets.length === 0 || secrets.some((s) => !(s instanceof Uint8Array)))
      throw new Error("secret must be a Uint8Array or non-empty array of Uint8Array");
    return secrets.map((s) => new Uint8Array(s));
  }

  // ── Public instance API ───────────────────────────────────────────────────

  get length() { return this.#entries.size; }
  get filter() { return this.#filter; }
  get ready() { return this.#allReady; }
  get secretCount() { return this.#secrets.length; }

  key(index) {
    if (index < 0 || index >= this.#entries.size) return null;
    let i = 0;
    for (const k of this.#entries.keys()) {
      if (i === index) return k;
      i++;
    }
    return null;
  }

  getItem(key) {
    key = String(key);
    const entry = this.#entries.get(key);
    if (entry) return entry.value;

    if (!this.#migrateData || this.#importUnencrypted === false) return null;

    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return null;
    }
    if (raw === null) return null;

    // Return the cleartext immediately so the app keeps working, but ask
    // synchronously while we are still inside the user gesture that called
    // getItem. Browsers block modal dialogs scheduled in a later microtask.
    this.#promptMigration(key, raw);
    return raw;
  }

  setItem(key, value) {
    key = String(key);
    value = String(value);
    const old = this.#entries.get(key);
    if (old && old.value === value) return;
    const nonce = this.#nextNonce();
    const timestamp = SafeStorage.timestampFromNonce(nonce);
    const entry = { key, value, timestamp, nonce };
    this.#applyEntry(entry, "local");
    this.#persistSet(entry).catch((e) => this.#emitError(e));
  }

  removeItem(key) {
    key = String(key);
    const entry = this.#entries.get(key);
    if (!entry) return;
    const oldValue = entry.value;
    this.#entries.delete(key);
    this.#emit({ type: "remove", key, oldValue, newValue: null, origin: "local" });
    const nonce = this.#nextNonce();
    const timestamp = SafeStorage.timestampFromNonce(nonce);
    const marker = { key, timestamp, nonce };
    this.#persistRemove(key, marker).catch((e) => this.#emitError(e));
    const handle = setTimeout(() => {
      this.#delayedRemoves.delete(handle);
      this.#reapplyRemove(key, marker).catch((e) => this.#emitError(e));
    }, this.#removeDelayMs);
    this.#delayedRemoves.add(handle);
  }

  clear() {
    const clearNonce = this.#nextNonce();
    const timestamp = SafeStorage.timestampFromNonce(clearNonce);
    this.#filter = timestamp;
    this.#filterNonce = clearNonce;
    try {
      localStorage.setItem(`${this.#namespace}__filter`, String(this.#filter));
    } catch {}
    const had = this.#entries.size > 0;
    this.#entries.clear();
    if (had)
      this.#emit({ type: "clear", key: null, oldValue: null, newValue: null, origin: "local" });
    this.#persistClear(clearNonce).catch((e) => this.#emitError(e));
  }

  upload() {
    const task = this.#upload();
    task.catch((e) => this.#emitError(e));
    return task;
  }

  migrate(newSecrets) {
    const task = this.#migrateSecrets(newSecrets);
    task.catch((e) => this.#emitError(e));
    return task;
  }

  clearSecret(index) {
    const task = this.#clearSecret(index);
    task.catch((e) => this.#emitError(e));
    return task;
  }

  onchange(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  onerror(cb) {
    this.#errorListeners.add(cb);
    return () => this.#errorListeners.delete(cb);
  }

  // ── Private instance helpers ──────────────────────────────────────────────

  #emit(event) { for (const cb of this.#listeners) cb(event); }
  #emitError(err) { for (const cb of this.#errorListeners) cb(err); }

  #nextNonce() {
    const now = Date.now();
    if (now !== this.#lastNow) {
      this.#lastNow = now;
      this.#nonceCounter = 0;
    } else {
      this.#nonceCounter = (this.#nonceCounter + 1) & 0xffff;
    }
    return SafeStorage.Base.createNonce(now, this.#nonceCounter);
  }

  #applyEntry(entry, origin) {
    const old = this.#entries.get(entry.key);
    const oldValue = old ? old.value : null;
    this.#entries.set(entry.key, entry);
    const changed = oldValue !== entry.value;
    if (changed)
      this.#emit({ type: "set", key: entry.key, oldValue, newValue: entry.value, origin });
    return changed;
  }

  #removeEntry(key, origin) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#emit({ type: "remove", key, oldValue: entry.value, newValue: null, origin });
    return true;
  }

  // In-memory conflict ordering. The nonce is a total order (timestamp →
  // counter → random), which is sufficient for the Store: connectors still
  // compare full blobs because they cannot decrypt, but the Store only needs
  // the nonce to decide whether an incoming operation is older, equal, or newer.
  #compareEntry(existing, nonce) {
    if (!existing) return 1;
    return SafeStorage.Base.compareNonces(nonce, existing.nonce);
  }

  #promptMigration(key, raw) {
    if (this.#importUnencrypted === true) {
      this.#importKey(key, raw);
      if (this.#removeUnencrypted === true) {
        try { localStorage.removeItem(key); } catch {}
      }
      return;
    }

    if (typeof confirm !== "function") {
      // Headless / no-modal environment: we cannot ask, so permanently decline
      // migration for this instance instead of returning plaintext on every read.
      this.#importUnencrypted = false;
      return;
    }

    let importOk;
    try {
      importOk = confirm(`Import unencrypted localStorage data into SafeStorage?`);
    } catch {
      return;
    }
    this.#importUnencrypted = importOk;
    if (!importOk) return;

    this.#importKey(key, raw);

    let removeOk;
    try {
      removeOk = confirm(`Remove unencrypted copies from localStorage?`);
    } catch {
      return;
    }
    this.#removeUnencrypted = removeOk;
    if (removeOk) {
      try { localStorage.removeItem(key); } catch {}
    }
  }

  #importKey(key, value) {
    const nonce = SafeStorage.Base.createNonce(1, 0);
    const entry = { key, value: String(value), timestamp: 1, nonce };
    this.#applyEntry(entry, "local");
    this.#persistSet(entry).catch((e) => this.#emitError(e));
  }

  async #deriveSecretRing(rawSecrets) {
    try {
      const ring = [];
      for (let index = 0; index < rawSecrets.length; index++) {
        const { nameKey, encryptionKey } = await SafeStorage.Base.expandSecret(rawSecrets[index]);
        const namespaceName = await SafeStorage.Base.hmacBase64(
          nameKey, SafeStorage.Base.utf8Encode("ns:" + this.#namespace),
        );
        ring.push({ index, nameKey, encryptionKey, namespaceName });
      }
      return ring;
    } catch (e) {
      this.#emitError(e);
      throw e;
    } finally {
      for (const secret of rawSecrets) secret.fill(0);
    }
  }

  async #replaceSecrets(rawSecrets) {
    const ring = await this.#deriveSecretRing(rawSecrets);
    this.#secrets = ring;
    this.#renumberSecrets();
    this.#namespaceName = this.#secrets[0].namespaceName;
  }

  #renumberSecrets() {
    for (let index = 0; index < this.#secrets.length; index++)
      this.#secrets[index].index = index;
  }

  #primarySecret() { return this.#secrets[0]; }

  #secretForName(name) {
    return this.#secrets.find((secret) =>
      name === secret.namespaceName || name.startsWith(secret.namespaceName + ":"),
    ) || null;
  }

  async #connectAndHydrate() {
    await this.#keysReady;
    const pending = [];
    let collecting = true;
    for (const c of this.#connectors) {
      c.onchange((name, blob) => {
        const p = this.#reconcile(name, blob, { source: c });
        if (collecting) pending.push(p);
      });
      for (const secret of this.#secrets) {
        try { await c.connect(secret.namespaceName); } catch (e) { this.#emitError(e); }
      }
    }
    await Promise.allSettled(pending);
    collecting = false;
  }

  async #connectSecretNamespaces(secrets) {
    for (const c of this.#connectors) {
      for (const secret of secrets) {
        try { await c.connect(secret.namespaceName); } catch (e) { this.#emitError(e); }
      }
    }
  }

  async #blobName(key, secret = null) {
    secret ||= this.#primarySecret();
    const kn = await SafeStorage.Base.hmacBase64(
      secret.nameKey, SafeStorage.Base.utf8Encode("key:" + this.#namespace + "\0" + key),
    );
    return secret.namespaceName + ":" + kn;
  }

  async #encryptPayload(payload, nonce, secret = null, waitForKeys = true) {
    if (waitForKeys) await this.#keysReady;
    secret ||= this.#primarySecret();
    const name = await this.#blobName(payload.key, secret);
    const json = JSON.stringify(payload);
    const aad = SafeStorage.Base.utf8Encode(name);
    const ct = await SafeStorage.Base.aesEncrypt(
      secret.encryptionKey, nonce, SafeStorage.Base.utf8Encode(json), aad,
    );
    return { name, blob: SafeStorage.Base.concatBytes(nonce, ct) };
  }

  async #persistSet(entry) {
    const { name, blob } = await this.#encryptPayload(
      SafeStorage.Base.buildValuePayload(entry), entry.nonce,
    );
    await this.#reconcile(name, blob, { origin: "local" });
  }

  async #persistRemove(key, marker) {
    const { name, blob } = await this.#encryptPayload(
      SafeStorage.Base.buildRemovePayload({ key, timestamp: marker.timestamp }), marker.nonce,
    );
    await this.#reconcile(name, blob, { origin: "local" });
  }

  async #reapplyRemove(key, marker) {
    await this.#persistRemove(key, marker);
  }

  async #persistClear(clearNonce) {
    await this.#keysReady;
    await this.#reconcile(this.#namespaceName, clearNonce, { origin: "local" });
  }

  async #upload() {
    await this.#keysReady;
    if (this.#filter > 0) {
      await this.#reconcile(
        this.#namespaceName,
        this.#filterNonce || SafeStorage.Base.createNonce(this.#filter, 0, SafeStorage.Base.randomBytes(3)),
        { origin: "local" },
      );
    }
    const entries = Array.from(this.#entries.values());
    for (const entry of entries) {
      const encrypted = await this.#encryptPayload(
        SafeStorage.Base.buildValuePayload(entry), entry.nonce,
      );
      await this.#reconcile(encrypted.name, encrypted.blob, { origin: "local" });
    }
  }

  async #migrateSecrets(newSecrets) {
    await this.#allReady;
    const replace = Array.isArray(newSecrets);
    const rawSecrets = SafeStorage.#normalizeSecrets(newSecrets);
    const oldReady = this.#keysReady;

    const task = (async () => {
      const derived = await this.#deriveSecretRing(rawSecrets);
      this.#secrets = replace ? derived : [...derived, ...this.#secrets];
      this.#renumberSecrets();
      this.#namespaceName = this.#secrets[0].namespaceName;
      await this.#connectSecretNamespaces(derived);
      await this.#rewriteCurrentStateWithPrimary();
    })();

    try {
      await task;
      this.#keysReady = Promise.resolve();
    } catch (e) {
      this.#keysReady = oldReady;
      throw e;
    }
  }

  async #rewriteCurrentStateWithPrimary() {
    if (this.#filter > 0) {
      const nonce = this.#filterNonce
        ? SafeStorage.Base.bumpNonce(this.#filterNonce)
        : SafeStorage.Base.createNonce(this.#filter, 0, SafeStorage.Base.randomBytes(3));
      this.#filter = SafeStorage.timestampFromNonce(nonce);
      this.#filterNonce = nonce;
      try { localStorage.setItem(`${this.#namespace}__filter`, String(this.#filter)); } catch {}
      await this.#reconcile(this.#namespaceName, nonce, { origin: "local" });
    }

    const entries = Array.from(this.#entries.values());
    for (const entry of entries) {
      const nonce = SafeStorage.Base.bumpNonce(entry.nonce);
      const timestamp = SafeStorage.timestampFromNonce(nonce);
      const migrated = { key: entry.key, value: entry.value, timestamp, nonce };
      this.#entries.set(entry.key, migrated);
      const encrypted = await this.#encryptPayload(
        SafeStorage.Base.buildValuePayload(migrated), nonce, this.#primarySecret(), false,
      );
      await this.#reconcile(encrypted.name, encrypted.blob, { origin: "local" });
    }
  }

  async #clearSecret(index) {
    await this.#keysReady;
    if (!Number.isInteger(index) || index < 0 || index >= this.#secrets.length)
      throw new RangeError("secret index out of range");
    const nonce = this.#nextNonce();
    const namespaceName = this.#secrets[index].namespaceName;
    for (const connector of this.#connectors) {
      try { await connector.clear(namespaceName, nonce); } catch (e) { this.#emitError(e); }
    }
  }

  #fanOutSet(source, name, blob) {
    SafeStorage.Base.fanOut(this.#connectors, source, (c) => {
      Promise.resolve(c.set(name, blob)).catch((e) => this.#emitError(e));
    });
  }

  #fanOutClear(source, namespaceName, nonce) {
    SafeStorage.Base.fanOut(this.#connectors, source, (c) => {
      Promise.resolve(c.clear(namespaceName, nonce)).catch((e) => this.#emitError(e));
    });
  }

  async #primaryCopyFromParsed(parsed, nonce) {
    const nextNonce = SafeStorage.Base.bumpNonce(nonce);
    const timestamp = SafeStorage.timestampFromNonce(nextNonce);
    const payload = "value" in parsed
      ? { key: parsed.key, value: parsed.value, timestamp }
      : { key: parsed.key, timestamp };
    const encrypted = await this.#encryptPayload(payload, nextNonce, this.#primarySecret());
    return { ...encrypted, nonce: nextNonce, timestamp };
  }

  async #reconcile(name, blobOrNull, { source = null, origin = "remote" } = {}) {
    try {
      await this.#keysReady;
      const NB = SafeStorage.NONCE_BYTES;
      const secret = this.#secretForName(name);
      if (!secret) return;

      if (name === secret.namespaceName) {
        if (!blobOrNull || blobOrNull.length !== NB || blobOrNull[0] !== SafeStorage.FORMAT_VERSION) return;
        if (secret.index !== 0) {
          this.#fanOutClear(source, name, blobOrNull);
          return;
        }
        const ts = SafeStorage.timestampFromNonce(blobOrNull);
        const newerClear = ts > this.#filter;
        if (newerClear) {
          this.#filter = ts;
          this.#filterNonce = blobOrNull;
          try { localStorage.setItem(`${this.#namespace}__filter`, String(ts)); } catch {}
          const had = this.#entries.size > 0;
          this.#entries.clear();
          if (had)
            this.#emit({ type: "clear", key: null, oldValue: null, newValue: null, origin });
        }
        if (newerClear || source === null) this.#fanOutClear(source, this.#namespaceName, blobOrNull);
        return;
      }

      // Physical absence is not trusted; only decryptable instructions change state.
      if (blobOrNull === null) return;

      const blob = blobOrNull;
      if (blob.length < NB || blob[0] !== SafeStorage.FORMAT_VERSION) return;
      // A key-level encrypted blob must contain the nonce plus at least the 16-byte AES-GCM auth tag.
      if (blob.length < NB + 16) {
        this.#emitError(new Error(`Blob too short to decrypt: ${name} (${blob.length} bytes)`));
        return;
      }
      const ts = SafeStorage.timestampFromNonce(blob);
      const nonce = blob.slice(0, NB);
      if (ts < this.#filter) return;

      // Local mutations are trusted: we just built and encrypted this blob, so
      // decrypting/validating it again is wasted work. Just fan it out.
      if (origin === "local") {
        this.#fanOutSet(source, name, blob);
        return;
      }

      const aad = SafeStorage.Base.utf8Encode(name);
      let plaintext;
      try {
        plaintext = await SafeStorage.Base.aesDecrypt(secret.encryptionKey, nonce, blob.slice(NB), aad);
      } catch {
        return;
      }

      let parsed;
      try { parsed = JSON.parse(SafeStorage.Base.utf8Decode(plaintext)); }
      catch (e) { this.#emitError(e); return; }

      if (!SafeStorage.Base.validatePayload(parsed, ts)) {
        this.#emitError(new Error("Invalid payload"));
        return;
      }

      const expectedName = await this.#blobName(parsed.key, secret);
      if (name !== expectedName) {
        this.#emitError(new Error("Blob name mismatch"));
        return;
      }

      const existing = this.#entries.get(parsed.key);
      const isRemove = !("value" in parsed);

      if (isRemove) {
        if (!existing) {
          this.#fanOutSet(source, name, blob);
          return;
        }
        const cmp = this.#compareEntry(existing, nonce);
        if (cmp < 0) return;
        if (cmp === 0) {
          this.#fanOutSet(source, name, blob);
          return;
        }
        this.#removeEntry(parsed.key, origin);
        if (secret.index === 0) {
          this.#fanOutSet(source, name, blob);
        } else {
          const primary = await this.#primaryCopyFromParsed(parsed, nonce);
          this.#fanOutSet(null, primary.name, primary.blob);
        }
        return;
      }

      const cmp = this.#compareEntry(existing, nonce);
      if (cmp < 0) return;
      if (cmp === 0) {
        this.#fanOutSet(source, name, blob);
        return;
      }

      if (secret.index === 0) {
        this.#applyEntry({
          key: parsed.key, value: parsed.value, timestamp: parsed.timestamp, nonce,
        }, origin);
        this.#fanOutSet(source, name, blob);
      } else {
        const primary = await this.#primaryCopyFromParsed(parsed, nonce);
        this.#applyEntry({
          key: parsed.key, value: parsed.value, timestamp: primary.timestamp, nonce: primary.nonce,
        }, origin);
        this.#fanOutSet(null, primary.name, primary.blob);
      }
    } catch (e) {
      this.#emitError(e);
    }
  }

  // ── Public static secret helpers ──────────────────────────────────────────

  // Convert a string to UTF-8 bytes for use as the `secret` constructor option.
  // This only encodes; it does not hash, stretch, or add entropy. The Store
  // mixes any received secret through HKDF-SHA-256 during construction.
  static utf8Secret(text) {
    return SafeStorage.Base.utf8Encode(text);
  }

  // Derive a high-entropy Uint8Array secret from a WebAuthn passkey (via the
  // PRF extension) or from a user passphrase prompt.
  static async passkeySecret({ namespace }) {
    const salt = SafeStorage.Base.utf8Encode(namespace);

    if (typeof PublicKeyCredential === "undefined")
      return SafeStorage.Base.utf8Encode(prompt("Enter passphrase for " + namespace) || "");

    let hasPasskey = false;
    try {
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: SafeStorage.Base.randomBytes(32),
          rpId: location.hostname,
          extensions: { prf: { eval: { first: salt } } },
        },
      });
      hasPasskey = true;
      const prf = cred.getClientExtensionResults().prf;
      if (prf?.results?.first) return new Uint8Array(prf.results.first);
    } catch {}

    if (!hasPasskey) {
      try {
        const cred = await navigator.credentials.create({
          publicKey: {
            challenge: SafeStorage.Base.randomBytes(32),
            rp: { name: namespace, id: location.hostname },
            user: {
              id: SafeStorage.Base.randomBytes(16),
              name: namespace, displayName: namespace,
            },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            authenticatorSelection: {
              residentKey: "required", userVerification: "required",
            },
            extensions: { prf: {} },
          },
        });
        if (cred.getClientExtensionResults().prf?.enabled)
          return SafeStorage.passkeySecret({ namespace });
      } catch {}
    }

    return SafeStorage.Base.utf8Encode(prompt("Enter passphrase for " + namespace) || "");
  }

  // ── Connectors (static nested classes) ────────────────────────────────────

  static SessionStorageConnector = class {
    // No-op placeholder: stores nothing and never emits.
    remote = false;

    connect() {}
    set() {}
    clear() {}
    onchange() {}
  };

  static LocalStorageConnector = class {
    // Local durable backend: remote-origin updates may be cached here.
    remote = false;

    #callback = null;
    #namespaces = new Set();
    #listening = false;

    connect(namespaceName) {
      this.#namespaces.add(namespaceName);
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(namespaceName + ":")) {
          try {
            this.#callback(key, SafeStorage.base64Decode(localStorage.getItem(key)));
          } catch {}
        }
      }
      if (!this.#listening && typeof addEventListener === "function") {
        this.#listening = true;
        addEventListener("storage", (e) => {
          if (!e.key || e.newValue === null) return;
          for (const ns of this.#namespaces) {
            if (e.key.startsWith(ns + ":")) {
              try {
                this.#callback(e.key, SafeStorage.base64Decode(e.newValue));
              } catch {}
              break;
            }
          }
        });
      }
    }

    set(name, blob) {
      const encoded = SafeStorage.base64Encode(blob);
      const existing = localStorage.getItem(name);
      if (existing !== null) {
        if (existing === encoded) return;
        try {
          if (SafeStorage.compareBytes(blob, SafeStorage.base64Decode(existing)) <= 0) return;
        } catch {}
      }
      localStorage.setItem(name, encoded);
    }

    clear(namespaceName, clearNonce) {
      const remove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(namespaceName + ":")) {
          try {
            const blob = SafeStorage.base64Decode(localStorage.getItem(key));
            if (SafeStorage.timestampFromNonce(blob) < SafeStorage.timestampFromNonce(clearNonce))
              remove.push(key);
          } catch {
            // Ignore undecodable entries; do not delete them silently.
          }
        }
      }
      for (const k of remove) localStorage.removeItem(k);
    }

    onchange(callback) { this.#callback = callback; }
  };

  static IndexedDBConnector = class {
    // Local durable backend: remote-origin updates may be cached here.
    remote = false;

    #callback = null;
    #db = null;
    #dbReady = null;
    #namespaces = new Set();
    #dbName;
    #storeName = "blobs";
    #channel = null;
    #id = SafeStorage.base64Encode(SafeStorage.Base.randomBytes(12));

    constructor(dbName = "encrypted-kv-store") {
      this.#dbName = dbName;
      if (typeof BroadcastChannel === "function") {
        this.#channel = new BroadcastChannel("SafeStorage.IndexedDBConnector:" + dbName);
        this.#channel.onmessage = (e) => this.#receiveBroadcast(e.data);
      }
    }

    #open() {
      if (this.#db) return Promise.resolve(this.#db);
      if (!this.#dbReady) {
        this.#dbReady = new Promise((resolve, reject) => {
          const req = indexedDB.open(this.#dbName, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(this.#storeName);
          req.onsuccess = () => {
            this.#db = req.result;
            resolve(this.#db);
          };
          req.onerror = () => reject(req.error);
        });
      }
      return this.#dbReady;
    }

    async connect(namespaceName) {
      this.#namespaces.add(namespaceName);
      const db = await this.#open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.#storeName, "readonly");
        const req = tx.objectStore(this.#storeName).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (typeof cursor.key === "string" && cursor.key.startsWith(namespaceName + ":"))
            this.#callback(cursor.key, new Uint8Array(cursor.value));
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    async set(name, blob) {
      const db = await this.#open();
      const stored = await new Promise((resolve, reject) => {
        const tx = db.transaction(this.#storeName, "readwrite");
        const store = tx.objectStore(this.#storeName);
        const req = store.get(name);
        let accepted = false;
        req.onsuccess = () => {
          if (req.result && SafeStorage.compareBytes(blob, new Uint8Array(req.result)) <= 0)
            return;
          store.put(blob, name);
          accepted = true;
        };
        tx.oncomplete = () => resolve(accepted);
        tx.onerror = () => reject(tx.error);
      });
      if (stored) this.#broadcast({ type: "set", name, blob });
    }

    async clear(namespaceName, clearNonce) {
      const db = await this.#open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.#storeName, "readwrite");
        const req = tx.objectStore(this.#storeName).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (typeof cursor.key === "string" && cursor.key.startsWith(namespaceName + ":")) {
            if (SafeStorage.timestampFromNonce(new Uint8Array(cursor.value)) < SafeStorage.timestampFromNonce(clearNonce))
              cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      this.#broadcast({ type: "clear", namespaceName, blob: clearNonce });
    }

    #broadcast(message) {
      if (!this.#channel) return;
      this.#channel.postMessage({ ...message, id: this.#id, blob: [...message.blob] });
    }

    #receiveBroadcast(message) {
      if (!message || message.id === this.#id) return;
      if (message.type === "set") {
        for (const ns of this.#namespaces) {
          if (message.name.startsWith(ns + ":")) {
            this.#callback(message.name, new Uint8Array(message.blob));
            return;
          }
        }
      }
      if (message.type === "clear" && this.#namespaces.has(message.namespaceName))
        this.#callback(message.namespaceName, new Uint8Array(message.blob));
    }

    onchange(callback) { this.#callback = callback; }
  };

  static WebSocketConnector = class {
    // Remote transport: inbound peer data is cached into local connectors.
    remote = true;

    #callback = null;
    #ws;
    #ready;
    #register = new Map();
    #namespaces = new Set();
    #clearNonce = null;
    #listening = false;

    constructor(ws) {
      this.#ws = typeof ws === "string" ? new WebSocket(ws) : ws;
      this.#ready = this.#ws.readyState === 1
        ? Promise.resolve()
        : new Promise((resolve) => this.#ws.addEventListener("open", resolve, { once: true }));
    }

    connect(namespaceName) {
      this.#namespaces.add(namespaceName);
      if (!this.#listening) {
        this.#listening = true;
        this.#ws.addEventListener("message", (e) => this.#receive(e.data));
      }
      return this.#ready;
    }

    async set(name, blob) {
      const stored = new Uint8Array(blob);
      const existing = this.#register.get(name);
      if (existing && SafeStorage.compareBytes(stored, existing) <= 0) return;
      this.#register.set(name, stored);
      await this.#ready;
      if (this.#register.get(name) === stored)
        this.#ws.send(name + "\t" + SafeStorage.base64Encode(stored));
    }

    async clear(namespaceName, clearNonce) {
      const stored = new Uint8Array(clearNonce);
      if (this.#clearNonce && SafeStorage.compareBytes(stored, this.#clearNonce) <= 0) return;
      this.#clearNonce = stored;
      this.#register.set(namespaceName, stored);
      await this.#ready;
      if (this.#register.get(namespaceName) === stored)
        this.#ws.send(namespaceName + "\t" + SafeStorage.base64Encode(stored));
    }

    #receive(data) {
      const tab = data.indexOf("\t");
      if (tab === -1) return;
      const name = data.slice(0, tab);
      const blobStr = data.slice(tab + 1);

      let match = false;
      for (const ns of this.#namespaces) {
        if (name === ns || name.startsWith(ns + ":")) { match = true; break; }
      }
      if (!match) return;

      if (blobStr === "") return; // physical absence is not trusted

      let blob;
      try {
        blob = SafeStorage.base64Decode(blobStr);
        if (blob.length < SafeStorage.NONCE_BYTES || blob[0] !== SafeStorage.FORMAT_VERSION) return;
      } catch {
        return;
      }

      const ts = SafeStorage.timestampFromNonce(blob);
      if (name.includes(":") && this.#clearNonce && ts < SafeStorage.timestampFromNonce(this.#clearNonce)) return;
      const existing = this.#register.get(name);
      if (existing && SafeStorage.compareBytes(blob, existing) <= 0) return;
      this.#register.set(name, blob);
      if (!name.includes(":")) this.#clearNonce = blob;
      this.#callback(name, blob);
    }

    onchange(callback) { this.#callback = callback; }
  };
}

// Register as a global property so SafeStorage is available in all
// environments (eval, require, importScripts, etc.), not only via the
// lexical scope of a <script> tag.
globalThis.SafeStorage = SafeStorage;
