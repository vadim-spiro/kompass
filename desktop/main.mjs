// Kompass desktop shell. It opens, in this order:
// 1. KOMPASS_URL when set: the Vite dev server (npm run desktop) or the team server (npm run desktop:remote).
// 2. The dev UI on :5173 when `npm run dev` is running, so both share one server and one workspace.
// 3. Otherwise its own workspace server, which also serves the built web app (npm run desktop:start).
//    It takes :8787; when another program holds that port, a free one and its own workspace file,
//    so two servers never write the same workspace.json.
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_UI = "http://localhost:5173/";
let server = null;
let serverExit = null;

const log = (...a) => console.log("[kompass]", ...a);

async function answers(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (serverExit != null) throw new Error(`The workspace server stopped (${serverExit}). Its output is in the terminal.`);
    if (await answers(url)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000} s. If it is the team server, this network may block it.`);
}

/** `port` when it is free on this machine, else a free one the system picks. */
function freePort(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      const any = createServer();
      any.listen(0, () => {
        const picked = any.address().port;
        any.close(() => resolve(picked));
      });
    });
    probe.listen(port, () => probe.close(() => resolve(port)));
  });
}

function startServer(port, ownWorkspace) {
  const env = { ...process.env, ENGINE_PORT: String(port), SERVE_WEB: join(root, "web", "dist") };
  if (ownWorkspace) env.WORKSPACE_FILE = join(root, "server", "workspace.desktop.json");
  const envFile = existsSync(join(root, ".env")) ? ["--env-file=../.env"] : [];
  server = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", ...envFile, "src/index.ts"], { cwd: join(root, "server"), env, stdio: "inherit" });
  server.on("exit", (code, signal) => {
    server = null;
    serverExit = signal ?? `exit code ${code}`;
    if (code) console.error(`[kompass] server exited with ${code}`);
  });
}

async function pickUrl() {
  if (process.env.KOMPASS_URL) return process.env.KOMPASS_URL;
  if (!process.env.KOMPASS_OWN_SERVER && (await answers(`${DEV_UI}api/status`))) {
    log("npm run dev is running: opening its UI (same server, same workspace)");
    return DEV_UI;
  }
  if (!existsSync(join(root, "web", "dist", "index.html"))) throw new Error("The web app is not built yet. Start the desktop app with: npm run desktop:start");
  const want = Number(process.env.ENGINE_PORT ?? 8787);
  const port = await freePort(want);
  if (port !== want) log(`port ${want} is taken: own server on ${port} with its own workspace (server/workspace.desktop.json)`);
  startServer(port, port !== want);
  return `http://localhost:${port}/`;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: "Kompass",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#f5f6f8",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  // Links to other sites open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  try {
    const url = await pickUrl();
    await waitFor(url);
    await win.loadURL(url);
    log(`window loaded ${url}`);
  } catch (e) {
    console.error(`[kompass] ${e.message}`);
    dialog.showErrorBox("Kompass could not start", e.message);
    app.quit();
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
app.on("before-quit", () => server?.kill());
