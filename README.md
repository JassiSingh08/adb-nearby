# adb-nearby

Find Android devices on your network and connect `adb` in one step — with QR
pairing, so you never type a six-digit code again.

```sh
npx adb-nearby
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
adbn list                     # show what is advertising, then exit
adbn list --json              # same, machine-readable
adbn pair                     # QR pairing for a new device
adbn pair 192.168.1.5:37123 123456   # code pairing, if you prefer
adbn doctor                   # explain why nothing is showing up
```

### Pairing with a QR code

`adbn pair` prints a QR code. On the phone, open **Settings → Developer options
→ Wireless debugging → Pair device with QR code** and scan it. The tool waits
for the device to appear, pairs, then connects — no codes, no ports.

It works because the payload is the same one Android Studio emits
(`WIFI:T:ADB;S:<name>;P:<password>;;`), with a name and password generated per
run so the device advertises a pairing service we can recognise.

### Stale ports heal themselves

The connect port changes whenever wireless debugging is toggled, and mDNS keeps
serving the old one for a while. When a connect is refused, `adbn` flushes the
mDNS cache, rescans and retries once — so you should not have to run it twice.

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

Guest and corporate networks often block mDNS outright. There, discovery cannot
work and you need the address directly: `adb connect <ip>:<port>`.

## License

MIT
