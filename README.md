<div align="center">

  ### 👇
  
  <p>
    <a href="https://github.com/EXLOUD/Net-Switcher/releases">
      <img src="https://img.shields.io/badge/Download_Net_Switcher-2ea44f?style=flat&logo=download&logoColor=white" height="40" alt="Download Net Switcher">
    </a>
  </p>

  ---
  
  ### 👀 Repository Stats
  
   <img alt="GitHub Views" src="https://count.getloli.com/get/@:EXLOUD-Net-S?theme=rule34" />

   **⭐ If this tool helped you, please consider giving it a star! ⭐**

</div>

---

<div align="center">

  <h1>Net Switcher</h1>

  **Language:** [English](#) | [Українська](README-UK.md)

  ![Version](https://img.shields.io/badge/Version-v1.0.0-6d4dee?style=for-the-badge)
  ![Root](https://img.shields.io/badge/Magisk%20%7C%20KernelSU%20%7C%20APatch-222222?style=for-the-badge)
  ![Network](https://img.shields.io/badge/iptables-per--app-isolation-success?style=for-the-badge)

  Per-app internet isolation for rooted Android devices.  
  Block Wi‑Fi, mobile data, LAN or VPN per package — or all of them at once.

</div>

---

**Author:** EXLOUD  
**GitHub:** https://github.com/EXLOUD  
**Fork of:** [Rem01Gaming/net-switch](https://github.com/Rem01Gaming/net-switch)

## 📋 Description

**Net Switcher** controls network access on a **per-app** basis using `iptables` rules managed by the `netswitcher` CLI.

For each installed package you can independently block:

| Channel | Meaning |
|---------|---------|
| **wifi** | Wi‑Fi |
| **mobile** | Cellular / mobile data |
| **lan** | Local network (LAN) |
| **vpn** | VPN interfaces |

- Toggle a single channel or **block all** with one switch.
- Save sets of rules as **profiles** and switch between them.
- Import / export profiles as JSON for backup or sharing.

Everything is managed from the built-in **WebUI** or from the command line.

## 🔧 Requirements

- **Root:** Magisk, KernelSU or APatch
- **WebUI:** open the module from your root manager (KernelSU / APatch / Magisk WebUI)
- No Zygisk required

## 🚀 Installation

1. Open your root manager (Magisk / KernelSU / APatch)
2. Install the `Net_Switcher_*.zip` module
3. Reboot (recommended after first install)
4. Open the module’s **WebUI**
5. Isolate the apps you need

## ⚙️ How it works

| Layer | Role |
|-------|------|
| **`netswitcher` CLI** | Applies and reads iptables rules; owns `rules.conf` |
| **`rules.conf`** | Current per-package blocked channels |
| **Profiles** | Named snapshots of rules (`profiles.json`) |
| **WebUI** | Lists apps, toggles channels, manages profiles and backups |

Rules are applied immediately when you toggle a switch. Profiles can be activated to replace the current set of rules in one step.

## 🖥️ WebUI

- **Apps:** searchable list (User / System / Isolated) with per-channel chips and a full-block switch
- **Profiles:** create, activate and delete named rule sets; set the current profile
- **Backup:** export profiles to a path on the device or import from a `.json` file (in-app file browser)
- **Events:** short log of recent isolate / allow actions
- **Languages:** English, Ukrainian, and more (see `webroot/locales/`)

Open it from the modules list in your root manager.

## 💻 Command line

```sh
/data/adb/modules/net-switcher/system/bin/netswitcher
```

Typical usage (via the same bridge the WebUI uses):

| Command | Description |
|---------|-------------|
| `netswitcher dump` | Print current rules (`pkg=wifi,mobile,...`) |
| `netswitcher set <pkg> <channels\|none>` | Set blocked channels for a package (`none` = allow all) |
| `netswitcher apply` | Re-apply rules (e.g. after activating a profile) |

Channels are a comma-separated list: `wifi`, `mobile`, `lan`, `vpn`.

Examples:

```sh
# Block only Wi-Fi for an app
netswitcher set com.example.app wifi

# Block everything
netswitcher set com.example.app wifi,mobile,lan,vpn

# Allow all channels again
netswitcher set com.example.app none

# Show current rules
netswitcher dump
```

## 📁 Configuration

Data lives **outside** the module folder so it survives updates:

```
/data/adb/.config/net-switcher/
├── rules.conf          # active per-app rules
├── profiles.json       # named profiles
├── default.json        # current profile name, etc.
└── old_profiles.json   # backup created on import
```

**Profile JSON** (modern format):

```json
{
  "Work": {
    "com.example.mail": ["wifi", "mobile"],
    "com.example.chat": ["wifi", "mobile", "lan", "vpn"]
  },
  "Travel": {
    "com.example.maps": ["mobile"]
  }
}
```

Legacy format (list of packages fully isolated) is also accepted on import.

## 📦 Module structure (typical)

```
📄 module.prop
📄 service.sh / post-fs-data.sh   # boot hooks (if present)
📂 system/bin/netswitcher           # CLI
📂 webroot/                       # WebUI (HTML / CSS / JS / locales)
```

Exact layout may vary slightly by release; the WebUI always talks to `netswitcher` under `/data/adb/modules/net-switcher/`.

## 🛡️ Safety

- Uninstalling the module should remove module files; config under `/data/adb/.config/net-switcher/` may remain until you delete it manually.
- You can clear rules with `netswitcher set <pkg> none` or by deactivating isolation in the WebUI.
- Disabling the module in the root manager stops further management until it is enabled again (existing iptables rules may need a reboot or explicit clear depending on release).

## ⚠️ Important notes

- Use at your own risk. Blocking the wrong system package can break updates, messaging, or other services.
- Isolation is based on package name and network interfaces; some apps may use unusual paths (e.g. secondary users, work profiles).
- Prefer isolating user apps first; be careful with system packages.

## 🆘 Troubleshooting

**WebUI shows “WebUI bridge unavailable”**
- Open the WebUI from KernelSU, APatch or Magisk’s module screen — not from a regular browser or `file://`

**Toggle does nothing / rules don’t stick**
- Check that the module is enabled and `netswitcher` exists:
  ```sh
  ls -l /data/adb/modules/net-switcher/system/bin/netswitcher
  netswitcher dump
  ```
- Confirm root and that no other firewall module is conflicting

**Import failed**
- JSON must be an object of profiles with at least one valid app rule
- Package names must match `[\w.]+`; channels must be from `wifi|mobile|lan|vpn`

**List jumps when toggling**
- Use a recent WebUI build; scroll position is preserved when updating a single row

## 📞 Support

- **GitHub:** https://github.com/EXLOUD

---

<div align="center">

**Warning:** This module changes network filtering rules. Make sure you understand the consequences before isolating system packages.

**[⬆ Back to Top](#net-switcher)**

</div>
