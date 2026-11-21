# Background browser behaviour

Search and ReadPage share one managed persistent context per selected installed
Chrome/Edge channel. Operations own independent pages. Identity detection uses a
blank page in that same context; its best-effort User-Agent override only replaces
the native `HeadlessChrome` product token, preserving the installed browser version.

Images, fonts and media load normally. URL routing still rejects non-HTTP(S) and
private-host requests, including navigation and subresources. The context-level
fallback guards unowned pages and the first popup request; page-level routing
keeps the smoke-only loopback exception isolated to its operation. Existing
navigation deadlines, cancellation and page cleanup bound background operations;
resource completion is not an additional readiness condition.

## Retained restrictions and defaults

- Service workers remain blocked. Playwright documents that `page.route` and
  `browserContext.route` do not intercept requests intercepted by service workers.
  Enabling them would leave gaps in the URL guard, including worker-controlled
  requests and traffic without a reliable owning operation. Safe restoration needs
  equivalent enforcement covering worker-handled and worker-initiated traffic,
  worker script updates, and persisted registrations before allowing registration.
- Downloads remain disabled and page download events are cancelled.
- Popups are closed and dialogs dismissed by handlers on the originating operation
  page. These handlers do not close other operation pages or change context state.
- Installed-browser selection, explicit `--headless=new` with `headless: false`,
  JavaScript, TLS verification, CSP enforcement and operational timeouts remain.
  No additional launch flags, identity rewriting or dependencies were introduced.
- Routing itself disables Playwright's HTTP cache. Retaining URL enforcement takes
  precedence over matching ordinary Chrome cache behaviour. Existing DNS checks
  remain best-effort: initial ReadPage validation resolves DNS separately from
  Chrome; per-request routing validates literal hosts, not resolved addresses.

## Future headed login

Background popup closure and dialog dismissal are unsuitable for interactive
authentication, consent and multi-window login flows. Headed login needs explicit
page ownership and lifecycle rules for interactive windows, while preserving the
background operations' network restrictions and isolation. Persistent storage alone
does not provide a supported login workflow. Service-worker-dependent sites remain
a compatibility limitation until the network-enforcement blocker is resolved.

## Verification

Run web regression tests with `npx vitest run test/web-*.test.ts`. Opt in to the
installed-Chrome resource-rendering and Pack 1 persistence smoke tests with:

```sh
WEB_BROWSER_SMOKE=1 npx vitest run test/web-browser-behaviour.smoke.test.ts test/web-persistent-browser.smoke.test.ts
```

The resource fixture checks decoded images, a loaded font, decoded audio, native
Chrome version/normalized UA on page and requests, blocked worker registration,
and a rejected loopback navigation alongside an unaffected concurrent page.
