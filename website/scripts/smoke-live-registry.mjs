import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targetUrl = process.env.MFW_REGISTRY_SMOKE_URL ?? "https://xmr.tex8.com/";
const timeoutMs = 30_000;
const browserCandidates = [
  process.env.MFW_BROWSER_EXECUTABLE,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function firstExecutable(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next supported Chromium-family browser.
    }
  }
  throw new Error(
    "No Chromium-family browser found. Set MFW_BROWSER_EXECUTABLE to run the live Registry smoke test.",
  );
}

function waitForDevtools(stderr) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser DevTools endpoint timed out")), timeoutMs);
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      stderr.off("data", onData);
      resolve(match[1]);
    };
    stderr.on("data", onData);
  });
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Browser connection failed")), {
        once: true,
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed");
  }
  return result.result.value;
}

async function waitFor(client, sessionId, expression, description) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(client, sessionId, expression);
    if (value) return value;
    await delay(200);
  }
  throw new Error(`${description} timed out${value ? `: ${JSON.stringify(value)}` : ""}`);
}

async function stopBrowser(browser) {
  if (browser.exitCode !== null) return;
  browser.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => browser.once("exit", resolve)),
    delay(3_000).then(() => browser.kill("SIGKILL")),
  ]);
}

const executable = await firstExecutable(browserCandidates);
const profileDirectory = await mkdtemp(join(tmpdir(), "mfw-registry-smoke-"));
const browser = spawn(
  executable,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-default-browser-check",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let client;
try {
  const devtoolsUrl = await waitForDevtools(browser.stderr);
  client = new CdpClient(devtoolsUrl);
  await client.open();
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  const url = new URL(targetUrl);
  url.searchParams.set("registry-smoke", Date.now().toString());
  url.hash = "registry";
  await client.send("Page.navigate", { url: url.toString() }, sessionId);
  await waitFor(
    client,
    sessionId,
    "document.readyState === 'complete' && document.querySelector('#mfw-name-check') !== null",
    "Registry form",
  );
  await evaluate(
    client,
    sessionId,
    `(() => {
      const input = document.querySelector('#mfw-name-check');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'tex8');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value === 'tex8';
    })()`,
  );
  await delay(100);
  await evaluate(
    client,
    sessionId,
    "document.querySelector('.registry-check-form button[type=submit]').click()",
  );
  const result = await waitFor(
    client,
    sessionId,
    `(() => {
      const success = document.querySelector('.registry-check-result.is-taken');
      const error = document.querySelector('.registry-check-result.is-error');
      if (success) return { ok: true, text: success.textContent.trim() };
      if (error) return { ok: false, text: error.textContent.trim() };
      return null;
    })()`,
    "Registry result",
  );
  if (!result.ok || !result.text.includes("tex8.mfw")) {
    throw new Error(`Registry frontend rejected tex8.mfw: ${result.text}`);
  }
  console.log(`Registry frontend smoke passed: ${result.text}`);
} finally {
  client?.close();
  await stopBrowser(browser);
  await rm(profileDirectory, { recursive: true, force: true });
}
