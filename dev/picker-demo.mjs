#!/usr/bin/env node
/**
 * Exercises the picker with fake devices, so the multi-device path can be felt
 * without owning several phones. Dev-only: `dev/` is outside package.json's
 * `files`, so it never ships.
 *
 *   node dev/picker-demo.mjs [count]
 */
import { c, ok, select } from "../src/ui.mjs";

const count = Number(process.argv[2] ?? 3);

const fake = Array.from({ length: count }, (_, i) => ({
  name: `adb-FAKE${String(i + 1).padStart(4, "0")}-Demo${i + 1}`,
  host: `192.168.29.${100 + i}`,
  port: 37000 + i * 137,
  kind: i === count - 1 ? "pairing" : "connect",
}));

const describe = (service) =>
  `${service.name}  ${c.dim(`${service.host}:${service.port}`)}` +
  (service.kind === "pairing" ? c.yellow("  [awaiting pairing]") : "");

const picked = await select("Nearby devices (demo)", fake, describe);

if (picked) ok(`would connect to ${picked.host}:${picked.port}`);
else console.log("cancelled");
