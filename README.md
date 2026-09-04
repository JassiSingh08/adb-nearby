# adb-nearby

Find Android devices on your network and connect `adb` in one step — with QR
pairing, so you never type a six-digit code again.

```sh
npx adb-nearby          # one-off
npm i -g adb-nearby     # then just `adbn`
```

```
Nearby devices
❯ adb-13930560280005N-VowoMk  192.168.29.118:40047
  adb-8821d0e4a19cbb02-Kw2nQ  192.168.29.202:44311

ok: I2202 on 192.168.29.118:40047
```

## Why

Wireless debugging is genuinely useful and genuinely annoying:

- **The connect port changes** every time you toggle wireless debugging, so any
  address you wrote down is dead.
- **The pairing port is different from the connect port**, single-use, and dies
  the moment the dialog closes.
- **`adb pair` reports network problems as protocol errors.** A VPN capturing
  the route or a phone on another subnet both surface as
  `protocol fault (couldn't read status message)`, which tells you nothing.
- **Auto-connect names transports after mDNS**, e.g.
  `adb-XXXX (2)._adb-tls-connect._tcp`. Tools that split a serial on whitespace
  — Expo among them — then call `adb -s adb-XXXX` and fail with
  `device not found`, while `adb devices` cheerfully shows the device online.

This wraps the parts of `adb` that already work, and defaults around the parts
that don't.

## Usage

```sh
adbn                          # discover, pick a device, connect
adbn connect 192.168.1.5:41039   # straight to a known address
adbn devices                  # what is attached, and what is missing
adbn list                     # show what is advertising, then exit
adbn list --json              # same, machine-readable
adbn pair                     # QR pairing for a new device
adbn pair 192.168.1.5:37123 123456   # code pairing, if you prefer
adbn doctor                   # explain why nothing is showing up
```

| option | |
|---|---|
| `--timeout <seconds>` | how long to scan (default 8). Raise it if a device was only just switched on. |
| `--clean` | drop mDNS-named transports — see below |
| `--json` | machine-readable output for `list` and `devices` |

### `adbn devices`

What `adb devices` makes you work out yourself:

```
Attached
  ● SM-S928B  Wi-Fi   192.168.29.178:45431  Android 16 (API 36)
  ○ I2202     Wi-Fi   192.168.29.118:41039  offline — stale, run adbn to clear

On the network, not connected
  ○ adb-13930560280005N-VowoMk  192.168.29.118:40295
  Run adbn to connect one.
```

Devices are named rather than numbered, with their Android version and how they
are attached. Anything wrong is called out — an offline transport left by a port
rotation, an mDNS-named one that will break Expo, or a device on the network you
simply have not connected yet. `--json` for scripts.

### Pairing with a QR code

`adbn pair` prints a QR code. On the phone, open **Settings → Developer options
→ Wireless debugging → Pair device with QR code** and scan it. The tool waits
for the device to appear, pairs, then connects — no codes, no ports.

It works because the payload is the same one Android Studio emits
(`WIFI:T:ADB;S:<name>;P:<password>;;`), with a name and password generated per
run so the device advertises a pairing service we can recognise.

### Unpaired devices are named as such

A device that has never been paired still advertises itself, so it shows up in
the picker — and then refuses the connection. `adb` reports that identically to
a dead port (`failed to connect`), which sends people looking for network
faults. `adbn` probes the socket to tell the two apart: if the port is open and
adb was still turned away, it says the device is unpaired and points at
`adbn pair`.

### Stale ports heal themselves

The connect port changes whenever wireless debugging is toggled, and mDNS keeps
serving the old one for a while. When nothing is listening on the port, `adbn`
rescans and retries with the address it finds, so you should not have to run it
twice.

It only restarts the adb server — the one way to flush a genuinely cached mDNS
record — if a plain rescan still comes back stale, because that restart drops
every other device's connection too.

### `--clean`

```sh
adbn --clean
```

Restarts the adb server with `ADB_MDNS_AUTO_CONNECT=0` before connecting, so the
device is only ever attached as `IP:port`. Use it when a tool reports
`device not found` for a device `adb devices` clearly shows.

It drops every existing adb connection, including Android Studio's, so it is
opt-in. Without it, `adbn` warns when it detects an mDNS-named transport rather
than tearing down your session.

## Requirements

- `adb` on `PATH` (Android platform-tools), or `ADB_PATH` pointing at it
- Node 18+
- Phone and computer on the same network, with mDNS not blocked

## Troubleshooting

Run `adbn doctor`. It prints the adb version, what is advertising, what is
attached, and — when nothing shows up — the causes in order of likelihood.

The two that catch people out:

- **Different subnets.** Compare the first three octets of the phone's IP and
  yours. `192.168.1.x` cannot reach `192.168.29.x`.
- **A VPN with a full-tunnel default route** swallows LAN traffic, so the phone
  is unreachable even on the same Wi-Fi. On macOS, check whether the route to
  the phone resolves to a `utun*` interface:
  `route -n get <phone-ip>`.

**"Discovered: 0" while devices are connected is normal.** Advertising and being
connected are independent: mDNS records lapse, while open transports keep
working. It only matters when you are trying to find a *new* device.

**mDNS needs a few seconds.** Discovery scans for 8s by default because shorter
windows report "nothing advertising" while a device is advertising the whole
time. If a phone was only just switched on, try `--timeout 20`.

Guest and corporate networks often block mDNS outright. There, discovery cannot
work and you need the address directly: `adb connect <ip>:<port>`.

## License

MIT
