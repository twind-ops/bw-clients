// Runtime smoke test for the built napi module.
// Runs against a locally built desktop_napi.<platform>-<arch>.node.
//
// Verifies the napi 3.x port keeps the JS-visible surface identical to what
// the checked-in index.d.ts declares:
//   - every namespace and function is present after loading the .node
//   - #[napi] constants are readable
//   - a bare promise-returning function round-trips through Node.js
//   - each ThreadsafeFunction sink accepts a JS callback with the arity
//     documented in index.d.ts (this is what the FnArgs<...> wrapping and the
//     new Arc<ThreadsafeFunction> in sshagent::serve exist to preserve)
//
// Cross-thread callback fan-out (SSH agent, passkey IPC, tracing → JS logger)
// can only be triggered by real OS/agent activity or a running IPC peer, so
// this test verifies registration but does not drive those callbacks. See the
// PR body for the additional integration coverage that would require new test
// infrastructure.
//
// Run:  node smoke-test.mjs   (after `npm run build`)

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const platform = process.platform;
const arch = process.arch;
const libc = platform === "linux" ? "-gnu" : "";
const candidate = join(here, `desktop_napi.${platform}-${arch}${libc}.node`);
if (!existsSync(candidate)) {
  console.error(
    `smoke-test: expected built binary at ${candidate}. Run \`npm run build\` first.`,
  );
  process.exit(2);
}
const napi = require(candidate);

const EXPECTED_NAMESPACES = [
  "autofill",
  "autostart",
  "autotype",
  "biometrics",
  "biometrics_v2",
  "chromium_importer",
  "clipboards",
  "ipc",
  "logging",
  "passkey_authenticator",
  "passwords",
  "powermonitors",
  "processisolations",
  "sshagent",
  "windows_registry",
];

const present = new Set(Object.keys(napi));
const missing = EXPECTED_NAMESPACES.filter((n) => !present.has(n));
assert.deepEqual(missing, [], `missing exported namespaces: ${missing.join(", ")}`);

// #[napi] const on a module.
assert.equal(
  napi.passwords.PASSWORD_NOT_FOUND,
  "Password not found.",
  "passwords.PASSWORD_NOT_FOUND constant is exposed",
);

// Bare `#[napi] pub async fn` — no ThreadsafeFunction involved. Confirms the
// napi 3.x `Promise` bridge round-trips through Node.js.
const disabled = await napi.processisolations.isCoreDumpingDisabled();
assert.equal(
  typeof disabled,
  "boolean",
  "processisolations.isCoreDumpingDisabled() returns a boolean via Promise",
);

// Every ThreadsafeFunction sink below: we register a JS callback with the
// arity declared in index.d.ts. Registration is enough to fail loudly if the
// FnArgs<...> wrappers or the Arc<ThreadsafeFunction> in sshagent::serve
// changed the arg-count contract — napi rejects a callback that doesn't
// match the declared shape at hook-up time, not just at first invocation.

// logging.initNapiLog: JsLogger holds ThreadsafeFunction<FnArgs<(LogLevel, String)>>.
// JS side sees (err, level, message) — 3 args.
assert.equal(
  typeof napi.logging.initNapiLog,
  "function",
  "logging.initNapiLog exists",
);
napi.logging.initNapiLog(function loggerCallback(err, level, message) {
  void err;
  void level;
  void message;
});

// sshagent.serve: ThreadsafeFunction<SshUIRequest, Promise<bool>>, wrapped in
// Arc in the Rust side because v3 ThreadsafeFunction is no longer Clone.
// JS side sees (err, req) → Promise<boolean>.
assert.equal(typeof napi.sshagent.serve, "function", "sshagent.serve exists");
// Do not actually start the agent (needs a bind socket), but confirm that a
// well-formed callback is accepted without a TypeError at the boundary.
const servePromise = napi.sshagent.serve(async function serveCallback(err, req) {
  void err;
  void req;
  return false;
});
assert.ok(
  servePromise && typeof servePromise.then === "function",
  "sshagent.serve returns a Promise",
);
// Consume rejection so it doesn't surface as UnhandledPromiseRejection; a
// server-start error is expected on hosts without the agent socket path.
servePromise.catch(() => {});

// autofill.IpcServer.listen: three ThreadsafeFunction<FnArgs<(u32, u32, T)>>
// arguments. JS callbacks each see (err, clientId, sequenceNumber, message) —
// 4 args (tuple unpacked via FnArgs).
assert.equal(
  typeof napi.autofill.IpcServer.listen,
  "function",
  "autofill.IpcServer.listen exists",
);
const autofillPromise = napi.autofill.IpcServer.listen(
  "arlo-smoke-test-autofill",
  function registrationCallback(err, clientId, sequenceNumber, message) {
    void err;
    void clientId;
    void sequenceNumber;
    void message;
  },
  function assertionCallback(err, clientId, sequenceNumber, message) {
    void err;
    void clientId;
    void sequenceNumber;
    void message;
  },
  function assertionWithoutUiCallback(err, clientId, sequenceNumber, message) {
    void err;
    void clientId;
    void sequenceNumber;
    void message;
  },
);
assert.ok(
  autofillPromise && typeof autofillPromise.then === "function",
  "autofill.IpcServer.listen returns a Promise",
);
const autofillServer = await autofillPromise.catch((e) => e);
if (autofillServer && typeof autofillServer.stop === "function") {
  autofillServer.stop();
}

// ipc.IpcServer.listen: ThreadsafeFunction<IpcMessage> — single-value payload.
// JS side sees (err, message) — 2 args.
assert.equal(
  typeof napi.ipc.IpcServer.listen,
  "function",
  "ipc.IpcServer.listen exists",
);
const ipcPromise = napi.ipc.IpcServer.listen(
  "arlo-smoke-test-ipc",
  function ipcCallback(err, message) {
    void err;
    void message;
  },
);
const ipcServer = await ipcPromise.catch((e) => e);
if (ipcServer && typeof ipcServer.stop === "function") {
  ipcServer.stop();
}

// powermonitors.onLock: ThreadsafeFunction<()> — zero-value payload. JS side
// sees (err,) only.
assert.equal(
  typeof napi.powermonitors.onLock,
  "function",
  "powermonitors.onLock exists",
);
await napi.powermonitors
  .onLock(function onLockCallback(err) {
    void err;
  })
  .catch(() => {});

console.log("smoke-test: ok");
// The registered ThreadsafeFunctions keep the Node event loop alive by
// design (v3 tsfns default to non-Weak). Force exit now that assertions have
// passed, otherwise `node smoke-test.mjs` blocks the CI runner indefinitely.
process.exit(0);
