const { spawn } = require("node:child_process");
const path = require("node:path");

const host = process.env.DEV_HOST || "127.0.0.1";
const wranglerPort = process.env.WRANGLER_PORT || "8788";
const vitePort = process.env.VITE_PORT || "5173";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const repoRoot = path.resolve(__dirname, "..");
const pagesAssetsDir = path.join(repoRoot, ".dev-pages");

const children = new Set();
let shuttingDown = false;

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler-logs",
    },
    shell: false,
    stdio: "inherit",
  });

  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      shutdown(signal ? 1 : code || 0);
    }
  });

  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

run(npm, ["run", "dev:vite", "--", "--host", host, "--port", vitePort, "--strictPort"]);

run(npm, [
  "exec",
  "--",
  "wrangler",
  "pages",
  "dev",
  pagesAssetsDir,
  "--ip",
  host,
  "--port",
  wranglerPort,
  "--show-interactive-dev-session=false",
]);
