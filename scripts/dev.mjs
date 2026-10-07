import { connect } from "node:net";
import { mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Temporal did not become ready on port ${port}.`);
}

const works = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;

// Each service runs in its own process group so shutting down stops all of it
// (npm, the shell it starts, and the Node process underneath).
const isWindows = process.platform === "win32";
// On Windows, npm is a .cmd script and needs a shell to start.
const startService = (command, args) => spawn(command, args, { stdio: "inherit", detached: !isWindows, shell: isWindows });
function stopService(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWindows) child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

// Start Temporal: Docker Desktop if it is running (as in the starter),
// otherwise the Temporal CLI if it is installed.
let temporalServer;
if (await portOpen(7233)) {
  console.log("Temporal is already running on port 7233.");
} else if (works("docker", ["info"])) {
  const compose = spawnSync("docker", ["compose", "up", "-d", "temporal"], { stdio: "inherit" });
  if (compose.status !== 0) {
    console.error("\nCould not start Temporal with Docker.");
    process.exit(compose.status ?? 1);
  }
} else if (works("temporal", ["--version"])) {
  console.log("Docker is not running; starting Temporal with the Temporal CLI instead.");
  mkdirSync(".temporal", { recursive: true });
  temporalServer = startService("temporal", [
    "server", "start-dev", "--ip", "127.0.0.1", "--db-filename", ".temporal/dev.db", "--log-level", "error",
  ]);
} else {
  console.error("\nCould not start Temporal. Start Docker Desktop (or install the Temporal CLI) and try again.");
  process.exit(1);
}

await waitForPort(7233);
const children = [startService("npm", ["run", "dev:worker"]), startService("npm", ["run", "dev:api"])];
let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) stopService(child);
  stopService(temporalServer);
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const child of children) {
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`A development process stopped (${signal ?? code}).`);
      shutdown(code ?? 1);
    }
  });
}
console.log("\nJuniper Salon waitlist is launching:");
console.log("  App:         http://localhost:3000");
console.log("  Temporal UI: http://localhost:8233\n");
