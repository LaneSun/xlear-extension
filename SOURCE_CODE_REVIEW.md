# Source code review notes

Xlear is a browser extension that hides posts matching shared filter lists while you browse
x.com. It talks to a server only to fetch the lists the user subscribed to; page content is
never uploaded from the extension.

## Build

Node.js 22 or newer and pnpm:

```bash
pnpm install
pnpm zip:firefox      # produces the extension and this sources archive
```

The submitted build used Node 24.18.1 and pnpm 11.9.0. No environment variables are needed and
nothing is read from `.env` at build time, so rebuilding this archive reproduces the submitted
output.

## Layout

| Path | What it is |
| --- | --- |
| `entrypoints/` | WXT entrypoints: background, popup, onboarding, options, and the two content scripts |
| `src/x/` | Everything that touches the x.com DOM: the scanner glue, filtering, the block dialog, the context-menu interceptor and the click executor |
| `src/core/` | Accounts, API calls, messaging, storage, sync |
| `src/ui/` | Shared Preact components and the stylesheet |
| `shared/` | Types, constants and the four-language dictionary |

WXT 0.21 (Vite, TypeScript, Preact, Tailwind 4) bundles everything; there is **no remote code**,
no runtime `eval` and no `new Function`. Tailwind's stylesheet is compiled at build time.

## Simulated clicks

The extension never sends an X write request of its own. Blocking and muting are always initiated
by the user and performed by X itself; the extension's only effect on X is hiding posts. It
synthesises clicks in exactly three places, each one the direct result of a user action:

1. The user clicks the extension's "block on X" button on a post card: the extension opens that
   post's own more-menu and clicks its "Block" item. X then shows its own confirmation dialog,
   which the user answers.
2. The user clicks X's own "Block" item: the extension does not rewrite X's behaviour, it only
   hides X's confirmation dialog and shows its own reason dialog instead.
3. The user submits the reason dialog (or chooses "block only"): the extension restores X's
   confirmation dialog and clicks X's confirm button for them.

See `src/x/blockmenu.ts` (1 and 2) and `src/x/executor.ts` (3 and the event sequence).

## Other notable details

- **No request forgery.** The extension never fetches post content from X; the server does that
  independently. The extension only reports "this post may belong to list X" together with the
  post id.
- **The server address is a compile-time constant** (`src/core/server.ts`) and appears in
  `host_permissions`. There is no setting for it, in the UI or in storage.
- **Permissions.** `host_permissions` cover `x.com`/`twitter.com` (to hide posts) and the server
  (to fetch lists). Firefox MV3 makes host permissions optional, so the onboarding page asks for
  them on first run through `browser.permissions.request` (see `src/core/permissions.ts`).
- **Storage.** Settings and small state live in `browser.storage.local`; the cached list entries
  live in IndexedDB, because they can run into hundreds of thousands of rows. Nothing is sent
  anywhere except the list fetches and the reports the user chooses to submit.
- **Optional WebDAV sync** (`src/sync/webdav.ts`) is off by default and only ever talks to the
  address the user enters for it.
