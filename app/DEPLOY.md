# Deploying fourk

The app is a fully static, fully client-side SPA: `pnpm build` produces
`dist/`, and any static host can serve it. There is no backend — the browser
talks directly to Kaspa nodes and signs transactions locally, which is why
the headers below matter more than for a typical static site.

## Build

```sh
cd app
pnpm install
pnpm build        # tsc + vite build → dist/
```

- **Root path assumed.** `vite.config.ts` sets no `base`, so the app must be
  served from the domain root (`https://example.com/`). To host under a
  sub-path (`/fourk/`), set `base: "/fourk/"` in `vite.config.ts` first.
- **SPA fallback not required.** The app is single-route; serving
  `index.html` at `/` is enough. (Adding a 404 → `index.html` rewrite is
  harmless if your host defaults to it.)

## Environment matrix

All variables are optional and documented in `.env.example`. Set them at
build time (they are baked into the bundle).

| Variable            | testnet-10 (today)                               | mainnet (future)                                                                                               |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `VITE_NETWORK_ID`   | unset (defaults to `testnet-10`) or `testnet-10` | `mainnet`                                                                                                      |
| `VITE_NODE_URL`     | unset (public resolver)                          | unset, or a `wss://` node — the CSP and browser mixed-content rules block plaintext `ws://` from an https page |
| `VITE_RESET_MARGIN` | unset                                            | unset (resets are a testnet concept)                                                                           |
| `VITE_COMMIT_SHA`   | see “Commit provenance”                          | same                                                                                                           |

Build-time validation (`vite.config.ts`): an unknown `VITE_NETWORK_ID`
(e.g. the `mainet` typo) fails the build; a production build on a test
network prints a loud warning — expected today, but it should always be a
choice, not an accident.

**Mainnet notes:** the faucet/free-play dispenser is testnet-only and
disappears on mainnet — every game is played with the players' own KAS.
Test the full stake/settle flow on testnet with the same build settings
before pointing a deploy at mainnet.

## Headers

`public/_headers` ships in every build (Vite copies `public/` → `dist/`)
and is consumed automatically by **Netlify** and **Cloudflare Pages**. It
carries the CSP, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, and immutable caching for
`/assets/*` — see the comments in that file for why each directive is
shaped the way it is (short version: `'wasm-unsafe-eval'` for the in-browser
kaspa wasm, broad `wss:`/`https:` in `connect-src` because node hostnames
come from the resolver at runtime).

**`frame-ancestors` needs real headers.** Browsers ignore it in a `<meta>`
CSP, and this app manages real keys — do not deploy to a host that cannot
send response headers. `index.html` contains only a minimal meta CSP
(`object-src`/`base-uri`) as defense in depth; it is not a substitute.

**Vercel** ignores `_headers`; put the equivalent in `vercel.json` at the
project root:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: https:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
        },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "no-referrer" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" }
      ]
    },
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    }
  ]
}
```

For nginx/CloudFront/etc., translate the same header set by hand.

## Caching & compression

- Everything under `/assets/` is content-hashed — `_headers` marks it
  `immutable` so browsers fetch each release once. `index.html` is not
  hashed; leave it on the host's default (revalidated) caching.
- The kaspa wasm is ~11.7 MB uncompressed. Netlify/Cloudflare/Vercel apply
  brotli/gzip on the wire automatically; no precompression step is needed.
  If you self-host, enable brotli for `application/wasm`.

## Commit provenance

The in-app version stamp (`__COMMIT_HASH__`) comes from
`git rev-parse --short=8 HEAD` at build time and falls back to `"unknown"`
when git can't answer. CI shallow checkouts usually still resolve HEAD, but
tarball builds or exotic CI setups may not — either ensure the checkout has
a `.git` (any depth), or set `VITE_COMMIT_SHA` in the build environment
(most CIs expose it, e.g. `VITE_COMMIT_SHA=$COMMIT_REF` on Netlify,
`$CF_PAGES_COMMIT_SHA` on Cloudflare Pages, `$VERCEL_GIT_COMMIT_SHA` on
Vercel); it overrides the git lookup and is truncated to 8 chars.
