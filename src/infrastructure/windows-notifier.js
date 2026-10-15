import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(projectRoot, "scripts", "show-toast.ps1");

export class WindowsNotifier {
  constructor({ enabled = true, platform = process.platform, spawnImpl = spawn, logger = console } = {}) {
    this.enabled = enabled;
    this.platform = platform;
    this.spawn = spawnImpl;
    this.logger = logger;
  }

  async notify({ title, body }) {
    if (!this.enabled || this.platform !== "win32") return { delivered: false, reason: "disabled_or_unsupported" };
    return new Promise((resolve) => {
      const child = this.spawn("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath, "-Title", String(title).slice(0, 120), "-Body", String(body).slice(0, 500),
      ], { windowsHide: true, stdio: "ignore" });
      child.once("error", (error) => {
        this.logger.warn?.(`[notify] ${error.message}`);
        resolve({ delivered: false, reason: "spawn_failed" });
      });
      child.once("exit", (code) => resolve({ delivered: code === 0, reason: code === 0 ? null : `exit_${code}` }));
    });
  }
}
