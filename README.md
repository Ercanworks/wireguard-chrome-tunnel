# WireGuard Chrome Tunnel

Tunnels only Chrome through WireGuard — the rest of the device is left alone.
WireGuard runs in user space with [wireproxy](https://github.com/whyvl/wireproxy)
and opens a local SOCKS5 proxy (`127.0.0.1:25344`); no network adapter or
system route is created.

## Features

- **All of Chrome** — all of Chrome's traffic goes through the tunnel. If the tunnel
  drops, Chrome does not connect directly (kill switch).
- **Selected tabs** — only the tabs you add are tunneled. The hosts a tab connects to
  are learned automatically; they are blocked until learned, so nothing leaks.
  > Chrome has no per-tab proxy support: if you open a tunneled site in another
  > tab, those requests go through the tunnel too.
- **ProtonVPN location picker** — using the Proton session open in Chrome, lists the
  countries your account can use, generates a WireGuard profile for the chosen
  country and connects. On each profile **↻** switches to another server in the same
  country, and **✕** also removes the profile from your Proton account.
- WebRTC IP leaks are blocked while the tunnel is up.

## Installation

1. Python 3.11+ and the dependencies: `pip install -r requirements.txt`
2. `Service setup.bat` → **[7]** download wireproxy, **[1]** install the service.
3. `chrome://extensions` → Developer mode → **Load unpacked** →
   the `Chrome Extension` folder (Chrome 137+).
4. For Proton, sign in to `account.protonvpn.com` once in Chrome.

Profiles are kept under `%PROGRAMDATA%\wg-chrome-manager\profiles`.

## Layout

| File | Role |
| --- | --- |
| `vpn_api.py` | Local API (`127.0.0.1:5000`): profiles, start/stop wireproxy, tunnel check |
| `wireguard_service.py` | Runs the API as a Windows service |
| `Chrome Extension/background.js` | Proxy routing, tab learning, Proton API |
| `Chrome Extension/popup.*` | UI |
