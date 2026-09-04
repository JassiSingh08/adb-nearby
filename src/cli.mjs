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
  const result = await adb.connect(service.host, service.port);
  if (!result.ok) {
    fail(result.out || "connect failed");
    warn(
      "the connect port changes every time wireless debugging is toggled — rerun to rediscover",
    );
    return 1;
  }

  const serial = `${service.host}:${service.port}`;
  const model = await adb.getProp(serial, "ro.product.model");
  ok(`${model || "device"} on ${serial}`);

  const attached = await adb.devices();
  const online = attached.filter((d) => d.state === "device");

  if (online.some((d) => adb.isMdnsSerial(d.serial))) {
    warn(
      "adb also auto-connected this device under an mDNS name.\n" +
        "  Tools that split the serial at the space (Expo included) will fail\n" +
        `  with "device not found". Rerun with ${c.bold("--clean")} to drop it.`,
    );
  }
  if (online.length > 1) {
    warn(
      `${online.length} transports attached — plain adb/expo will report "more than one device".\n` +
        `  Unplug USB, or pass ${c.bold(`-s ${serial}`)}`,
    );
  }

  return 0;
}

async function doctor() {
  const version = await adb.version();
  if (version) ok(version);
  else fail("adb not found");

  const services = await discover(6, { quiet: true });
  const attached = await adb.devices();

  console.log(`\n${c.bold("Discovered")}: ${services.length}`);
  services.forEach((s) => console.log(`  ${describe(s)}`));
  console.log(`\n${c.bold("Attached")}: ${attached.length}`);
  attached.forEach((d) => console.log(`  ${d.raw}`));

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
