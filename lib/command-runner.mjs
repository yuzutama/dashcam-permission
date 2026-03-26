import { spawnSync } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { delimiter, join } from "path";

function candidatePaths(command) {
  const pathValue = process.env.PATH || "";
  const dirs = pathValue.split(delimiter).filter(Boolean);

  if (process.platform !== "win32") {
    return dirs.map((dir) => join(dir, command));
  }

  const pathExt = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);

  const hasExt = /\.[^/\\]+$/.test(command);
  const names = hasExt ? [command] : [command, ...pathExt.map((ext) => `${command}${ext.toLowerCase()}`), ...pathExt.map((ext) => `${command}${ext.toUpperCase()}`)];
  return dirs.flatMap((dir) => names.map((name) => join(dir, name)));
}

export function commandExists(command) {
  for (const candidate of candidatePaths(command)) {
    if (!existsSync(candidate)) continue;
    if (process.platform === "win32") return true;
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || `${command} exited with code ${result.status}`).trim();
    const error = new Error(message);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }

  return result;
}
