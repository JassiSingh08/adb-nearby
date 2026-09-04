import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const ADB = process.env.ADB_PATH || "adb";

/** mDNS auto-connect is what names a transport `adb-XXXX (2)._adb-tls-connect._tcp`,
 *  which tools like Expo truncate at the space into a serial that matches nothing. */
const NO_AUTO_CONNECT = { ...process.env, ADB_MDNS_AUTO_CONNECT: "0" };

export class AdbMissingError extends Error {
  constructor() {
    super(
      "adb was not found on PATH.\n" +
        "  Install Android platform-tools, or set ADB_PATH to the binary.\n" +
        "  macOS: ~/Library/Android/sdk/platform-tools/adb",
    );
    this.name = "AdbMissingError";
  }
}

async function adb(args, { env = process.env, timeout = 20_000 } = {}) {
  try {
    const { stdout, stderr } = await run(ADB, args, { env, timeout });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (error) {
    if (error.code === "ENOENT") throw new AdbMissingError();
    // adb reports most failures on stdout with a non-zero exit.
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() };
  }
}

export async function version() {
  const { ok, out } = await adb(["version"]);
  return ok ? out.split("\n")[0] : null;
}

export async function startServer() {
  await adb(["start-server"], { env: NO_AUTO_CONNECT });
}

/** Only way to change ADB_MDNS_AUTO_CONNECT, since it is read at server start.
 *  Disruptive: it drops every current connection, including Android Studio's. */
export async function restartServerClean() {
  await adb(["kill-server"]);
  await adb(["start-server"], { env: NO_AUTO_CONNECT });
}

/**
 * `adb mdns services` prints `name \t type \t host:port` after a header line.
 * Devices advertise `_adb-tls-connect._tcp` while wireless debugging is on, and
 * `_adb-tls-pairing._tcp` only while the pairing dialog is open.
 */
export async function mdnsServices() {
  const { ok, out } = await adb(["mdns", "services"]);
  if (!ok) return [];

  return out
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3 && cells[1].startsWith("_adb"))
    .map(([name, type, address]) => {
      const at = address.lastIndexOf(":");
      return {
        name,
        type,
        host: address.slice(0, at),
        port: Number(address.slice(at + 1)),
        kind: type.includes("pairing") ? "pairing" : "connect",
      };
    })
    .filter((entry) => entry.host && Number.isFinite(entry.port));
}

/** Polls until `predicate` matches a service or the deadline passes. */
export async function waitForService(predicate, { timeoutMs, everyMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await mdnsServices()).find(predicate);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

export async function devices() {
  const { ok, out } = await adb(["devices", "-l"]);
  if (!ok) return [];

  return out
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state, raw: line };
    })
    .filter((device) => device.serial);
}

export async function connect(host, port) {
  const { out } = await adb(["connect", `${host}:${port}`]);
  // adb exits 0 on a refused connection, so the text is the only signal.
  const failed = /failed to connect|refused|unable to connect|cannot connect/i;
  return { ok: !failed.test(out), out };
}

export async function disconnect(target) {
  await adb(["disconnect", ...(target ? [target] : [])]);
}

export async function pair(host, port, code) {
  const { out } = await adb(["pair", `${host}:${port}`, code], {
    timeout: 30_000,
  });
  return { ok: /successfully paired/i.test(out), out };
}

export async function getProp(serial, prop) {
  const { ok, out } = await adb(["-s", serial, "shell", "getprop", prop]);
  return ok ? out.trim() : null;
}

/** A transport adb named from mDNS rather than an address. Expo and friends
 *  split these at the space and end up with a serial that matches no device. */
export const isMdnsSerial = (serial) => serial.includes("._adb-tls-");
