import { randomBytes } from "node:crypto";
import qrcode from "qrcode-terminal";

import * as adb from "./adb.mjs";
import { c, fail, info, ok, warn } from "./ui.mjs";

/**
 * The phone's "Pair device with QR code" scanner reads the same payload
 * Android Studio emits: a WIFI URI with T:ADB. Scanning it makes the device
 * advertise `_adb-tls-pairing._tcp` under the name we chose, with the password
 * we chose — so we can pair without anyone typing a six-digit code.
 */
const qrPayload = (name, password) => `WIFI:T:ADB;S:${name};P:${password};;`;

const token = (bytes) => randomBytes(bytes).toString("base64url").slice(0, bytes * 2);

export async function pairWithQr({ timeoutMs = 120_000 } = {}) {
  const name = `adb-nearby-${token(3)}`;
  const password = token(6);

  console.log();
  qrcode.generate(qrPayload(name, password), { small: true });
  console.log(
    `On the phone: ${c.bold("Settings → Developer options → Wireless debugging → Pair device with QR code")}`,
  );
  info(`waiting up to ${Math.round(timeoutMs / 1000)}s for the scan…`);

  const service = await adb.waitForService(
    (entry) => entry.kind === "pairing" && entry.name === name,
    { timeoutMs },
  );

  if (!service) {
    fail(
      "no pairing request arrived.\n" +
        "  The QR expires when the dialog closes — rerun and scan promptly.\n" +
        "  Also check the phone and this machine are on the same network.",
    );
    return null;
  }

  info(`pairing with ${service.host}:${service.port}`);
  const result = await adb.pair(service.host, service.port, password);
  if (!result.ok) {
    fail(`pairing failed: ${result.out}`);
    return null;
  }

  ok("paired");
  return service.host;
}

export async function pairWithCode(target, code) {
  const at = target.lastIndexOf(":");
  if (at < 0) {
    fail("pass the pairing address as host:port, e.g. 192.168.1.5:37123");
    return null;
  }

  const host = target.slice(0, at);
  const port = Number(target.slice(at + 1));
  const result = await adb.pair(host, port, code);

  if (!result.ok) {
    fail(`pairing failed: ${result.out}`);
    warn(
      "the pairing port is single-use and dies with the dialog — reopen it for a fresh port and code",
    );
    return null;
  }

  ok("paired");
  return host;
}
