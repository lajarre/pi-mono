# tmux Setup

Pi works inside tmux, but tmux strips modifier information from certain keys by default and blocks terminal passthrough unless configured. Without setup, modified Enter keys and Kitty-protocol inline images may not work reliably.

## Recommended Configuration

Add to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Then restart tmux fully:

```bash
tmux kill-server
tmux
```

Pi requests extended key reporting automatically when Kitty keyboard protocol is not available. With `extended-keys-format csi-u`, tmux forwards modified keys in CSI-u format, which is the most reliable configuration.

## Inline Images (Kitty Graphics Protocol)

Pi renders inline images via the Kitty graphics protocol in
Ghostty, Kitty, and WezTerm. Inside tmux, Pi wraps image
sequences in DCS passthrough automatically, but tmux must be
configured to allow it:

```tmux
set -g allow-passthrough on
```

Without this, tmux filters Kitty image sequences before they
reach the terminal. Pi detects image support but nothing
renders.

### Security tradeoff

tmux filters escape sequences by default to prevent
applications from sending arbitrary data to the terminal
emulator. `allow-passthrough on` disables that filter for the
visible pane, allowing any escape sequence to reach the
terminal directly.

This is the same setting required by other tools that render
images inside tmux (yazi, kitty icat, etc.).

Risks when passthrough is enabled:

- Untrusted output (`cat`, `curl`, scripts) can send escape
  sequences directly to the terminal
- Terminal vulnerabilities become exploitable through escape
  sequence injection (e.g. CVE-2024-38396 in iTerm2)
- OSC 52 clipboard access is no longer filtered by tmux

`on` restricts passthrough to the currently visible pane.
`all` extends it to invisible panes — avoid this unless
specifically needed.

If you do not want to enable passthrough, inline images will
not render inside tmux. Everything else (keyboard, text
rendering, all non-image features) works without it.

### Adding passthrough to the recommended config

If you want inline images, add to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
set -g allow-passthrough on
```

## Why `csi-u` Is Recommended

With only:

```tmux
set -g extended-keys on
```

tmux defaults to `extended-keys-format xterm`. When an application requests extended key reporting, modified keys are forwarded in xterm `modifyOtherKeys` format such as:

- `Ctrl+C` → `\x1b[27;5;99~`
- `Ctrl+D` → `\x1b[27;5;100~`
- `Ctrl+Enter` → `\x1b[27;5;13~`

With `extended-keys-format csi-u`, the same keys are forwarded as:

- `Ctrl+C` → `\x1b[99;5u`
- `Ctrl+D` → `\x1b[100;5u`
- `Ctrl+Enter` → `\x1b[13;5u`

Pi supports both formats, but `csi-u` is the recommended tmux setup.

## What This Fixes

Without tmux extended keys, modified Enter keys collapse to legacy sequences:

| Key | Without extkeys | With `csi-u` |
|-----|-----------------|--------------|
| Enter | `\r` | `\r` |
| Shift+Enter | `\r` | `\x1b[13;2u` |
| Ctrl+Enter | `\r` | `\x1b[13;5u` |
| Alt/Option+Enter | `\x1b\r` | `\x1b[13;3u` |

This affects the default keybindings (`Enter` to submit, `Shift+Enter` for newline) and any custom keybindings using modified Enter.

## Requirements

- tmux 3.2 or later for extended keys (run `tmux -V` to check)
- tmux 3.3 or later for `allow-passthrough` (inline images)
- A terminal emulator that supports extended keys (Ghostty,
  Kitty, iTerm2, WezTerm, Windows Terminal)
