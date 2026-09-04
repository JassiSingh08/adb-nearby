#!/usr/bin/env node
import * as adb from "./adb.mjs";
import { pairWithCode, pairWithQr } from "./pair.mjs";
import { c, fail, info, ok, select, spinner, warn } from "./ui.mjs";

const HELP = `
${c.bold("adb-nearby")} — find Android devices on your network and connect adb in one step

  ${c.bold("adbn")}                 discover, pick a device, connect
  ${c.bold("adbn list")}            list what is advertising, and exit
  ${c.bold("adbn pair")}            show a QR code to pair a new device
  ${c.bold("adbn pair <host:port> <code>")}
                        pair with the six-digit code instead
  ${c.bold("adbn doctor")}          explain why nothing is showing up

Options
  --clean               restart the adb server with mDNS auto-connect off.
                        Fixes tools that choke on mDNS-named transports, but
                        drops every existing adb connection.
  --timeout <seconds>   how long to wait for discovery (default 8)
  --json                machine-readable output for list
  -h, --help            this

Requires wireless debugging: Settings → Developer options → Wireless debugging.
`;

function parseArgs(argv) {
  const flags = { clean: false, json: false, timeout: 8 };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--clean") flags.clean = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--timeout") flags.timeout = Number(argv[++i]) || 8;
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else positional.push(arg);
  }

  return { flags, positional };
}

async function discover(timeoutSec, { quiet = false } = {}) {
  await adb.startServer();

  const deadline = Date.now() + timeoutSec * 1000;
  const seen = [];

  const stop = quiet
    ? () => {}
    : spinner((elapsed) => {
        const found = seen.length
          ? `${seen.length} found`
          : "nothing yet";
        return `scanning the network… ${elapsed}s / ${timeoutSec}s  ${c.dim(found)}`;
      });

  // mDNS answers trickle in, so keep looking until the window closes rather
  // than trusting the first reply.
  try {
    for (;;) {
      for (const service of await adb.mdnsServices()) {
        if (!seen.some((s) => s.name === service.name)) seen.push(service);
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } finally {
    stop();
  }

  return seen;
}

const describe = (service) =>
  `${service.name}  ${c.dim(`${service.host}:${service.port}`)}` +
  (service.kind === "pairing" ? c.yellow("  [awaiting pairing]") : "");

async function connectTo(service, flags) {
  if (flags.clean) {
    info("restarting the adb server with mDNS auto-connect off");
    await adb.restartServerClean();
  }

  info(`connecting to ${service.host}:${service.port}`);
  let target = service;
  let result = await adb.connect(target.host, target.port);

  if (!result.ok) {
    // adb says "failed to connect" for both a dead port and a rejected
    // handshake, so ask the socket which one it was.
    const listening = await adb.tcpOpen(target.host, target.port);

    if (listening) {
      // Something is there and it turned us away: the device does not trust
      // this machine. Nothing about reconnecting will help.
      fail(`${target.host} refused the connection`);
      console.log(
        `  It is reachable, so this is almost certainly an unpaired device —\n` +
          `  it will not accept adb until you pair with it once.\n\n` +
          `  Fix: ${c.bold("adbn pair")}, then scan the QR on that device under\n` +
          `  Settings → Developer options → Wireless debugging → Pair device with QR code`,
      );
      return 1;
    }

    // Nothing listening: the port almost always changed under us on the last
    // wireless-debugging toggle. Flushing the mDNS cache is what fixes it, so
    // retry once instead of making the user run the command twice.
    info("that port is stale — flushing the mDNS cache and rescanning");
    await adb.restartServerClean();

    const fresh = await discover(Math.max(6, flags.timeout));
    const rediscovered = fresh.find(
      (entry) => entry.kind === "connect" && entry.name === service.name,
    );

    if (rediscovered && rediscovered.port !== service.port) {
      target = rediscovered;
      info(`connecting to ${target.host}:${target.port}`);
      result = await adb.connect(target.host, target.port);
    }
  }

  if (!result.ok) {
    fail(result.out || "connect failed");
    warn(
      "wireless debugging may have been toggled off, or the device left the network",
    );
    return 1;
  }

  const serial = `${target.host}:${target.port}`;
  const model = await adb.getProp(serial, "ro.product.model");
  ok(`${model || "device"} on ${serial}`);

  const attached = await adb.devices();
  const online = attached.filter((d) => d.state === "device");

  const duplicates = online.filter((d) => adb.isMdnsSerial(d.serial));
  // Counted apart from the duplicates: two transports for one phone is a
  // problem to fix, whereas two phones is just how you were working.
  const real = online.filter((d) => !adb.isMdnsSerial(d.serial));

  if (duplicates.length) {
    warn(
      `this device is attached twice — once as ${serial}, once under its mDNS name.\n` +
        `  Tools that split a serial on whitespace (Expo included) will fail with\n` +
        `  "device not found", and plain adb will say "more than one device".\n` +
        `  Fix: ${c.bold("adbn --clean")}`,
    );
  } else if (real.length > 1) {
    info(
      `${real.length} devices attached. Target this one with ${c.bold(`-s ${serial}`)}`,
    );
  }

  // The connect path is the only one most people ever run, so it is the only
  // place the rest of the tool gets discovered. Names only — pairing a label to
  // each with a separator made three commands read as six.
  console.log(
    c.dim(`   also: adbn pair, adbn list, adbn doctor  ·  adbn --help`),
  );

  return 0;
}

/**
 * A full-tunnel VPN swallows LAN traffic, so the phone is unreachable even on
 * the same Wi-Fi — and adb reports that as a protocol fault, which sends people
 * hunting for the wrong thing. Returns the tunnel interface, or null.
 */
async function vpnRouteTo(host) {
  if (!host || process.platform !== "darwin") return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("route", ["-n", "get", host], {
      timeout: 3000,
    });
    const iface = stdout.match(/interface:\s*(\S+)/)?.[1];
    return iface && /^(utun|tun|ppp|ipsec)/.test(iface) ? iface : null;
  } catch {
    return null;
  }
}

async function doctor() {
  const version = await adb.version();
  if (version) ok(version);
  else fail("adb not found");

  const services = await discover(6);
  const attached = await adb.devices();

  console.log(`\n${c.bold("Discovered")}: ${services.length}`);
  services.forEach((s) => console.log(`  ${describe(s)}`));
  console.log(`\n${c.bold("Attached")}: ${attached.length}`);
  attached.forEach((d) => console.log(`  ${d.raw}`));

  // Finding a device is not the same as being in a good state, so say so.
  const notes = [];
  const online = attached.filter((d) => d.state === "device");

  if (online.some((d) => adb.isMdnsSerial(d.serial))) {
    notes.push(
      `A transport is attached under an mDNS name. Expo and anything else that\n` +
        `     splits a serial on whitespace will say "device not found".\n` +
        `     Fix: ${c.bold("adbn --clean")}`,
    );
  }
  if (online.length > 1) {
    notes.push(
      `${online.length} transports attached, so plain adb will refuse with\n` +
        `     "more than one device". Unplug USB, or pass ${c.bold("-s <serial>")}.`,
    );
  }
  if (attached.some((d) => d.state === "unauthorized")) {
    notes.push(
      `A device is unauthorized — accept the "Allow USB debugging" prompt on it.`,
    );
  }
  if (attached.some((d) => d.state === "offline")) {
    notes.push(
      `A device is offline: a dead transport from a previous session.\n` +
        `     Fix: ${c.bold("adb disconnect")}, then ${c.bold("adbn")}.`,
    );
  }

  const unattached = services.filter(
    (s) =>
      s.kind === "connect" &&
      !online.some((d) => d.serial === `${s.host}:${s.port}`),
  );
  if (unattached.length && online.length === 0) {
    notes.push(`Device found but not connected. Run ${c.bold("adbn")}.`);
  }
  if (services.some((s) => s.kind === "pairing")) {
    notes.push(
      `A device is waiting to pair. Run ${c.bold("adbn pair")} (or scan its QR).`,
    );
  }

  const vpn = await vpnRouteTo(services[0]?.host);
  if (vpn) {
    notes.push(
      `The route to ${services[0].host} goes via ${c.bold(vpn)}, a VPN tunnel.\n` +
        `     LAN traffic is being captured; disconnect the VPN to reach the device.`,
    );
  }

  if (notes.length) {
    console.log(`\n${c.bold("Worth knowing")}:`);
    notes.forEach((note, i) => console.log(`  ${i + 1}. ${note}`));
  } else if (services.length) {
    console.log(`\n${c.green("Nothing looks wrong.")}`);
  }

  if (services.length === 0) {
    console.log(`\n${c.bold("Nothing is advertising. In order of likelihood:")}`);
    console.log(`  1. Wireless debugging is off on the phone.`);
    console.log(
      `  2. The phone and this machine are on different networks — compare the first three octets of their IPs.`,
    );
    console.log(
      `  3. A VPN is capturing the route. Check whether your default route is a utun*/tun* interface.`,
    );
    console.log(`  4. The network blocks mDNS (common on guest and corporate Wi-Fi).`);
    console.log(
      `\n  With a known IP you can skip discovery entirely: ${c.bold("adb connect <ip>:<port>")}`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const [command, ...rest] = positional;

  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  try {
    if (command === "doctor") {
      await doctor();
      return 0;
    }

    if (command === "pair") {
      const host =
        rest.length >= 2
          ? await pairWithCode(rest[0], rest[1])
          : await pairWithQr();
      if (!host) return 1;

      // Pairing does not connect, and the connect port differs from the
      // pairing one, so find the device again now that it is trusted.
      info("looking for the device to connect");
      const service = await adb.waitForService(
        (entry) => entry.kind === "connect" && entry.host === host,
        { timeoutMs: 15_000 },
      );
      if (!service) {
        warn(
          `paired, but ${host} is not advertising a connect port yet. Run ${c.bold("adbn")} in a moment.`,
        );
        return 0;
      }
      return connectTo(service, flags);
    }

    const services = await discover(flags.timeout);

    if (command === "list") {
      if (flags.json) console.log(JSON.stringify(services, null, 2));
      else if (services.length === 0) console.log("nothing advertising");
      else services.forEach((s) => console.log(describe(s)));
      return 0;
    }

    if (services.length === 0) {
      fail("no devices advertising on this network");
      // mDNS needs a few seconds after the adb server starts, so an immediate
      // run right after flipping wireless debugging on often just missed it.
      console.log(
        `  Just turned wireless debugging on? Give it longer: ${c.bold(`adbn --timeout ${Math.max(20, flags.timeout * 2)}`)}`,
      );
      console.log(
        `  Never paired with this machine? ${c.bold("adbn pair")}`,
      );
      console.log(`  Still nothing? ${c.bold("adbn doctor")}`);
      return 1;
    }

    const connectable = services.filter((s) => s.kind === "connect");
    if (connectable.length === 0) {
      warn("only pairing services found — this device is not paired yet");
      console.log(`  Run ${c.bold("adbn pair")}.`);
      return 1;
    }

    const picked = await select("Nearby devices", connectable, describe);
    if (!picked) return 1;

    return connectTo(picked, flags);
  } catch (error) {
    fail(error.message);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
