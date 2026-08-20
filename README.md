# extract

A paid Markdown extraction endpoint on Cloudflare Workers. An agent POSTs a
URL, pays $0.01 in USDC on Base mainnet, and gets back clean Markdown with a
SHA-256 of the exact bytes and an ISO retrieval timestamp.

No signup, no API key, no account. Payment is the authentication.

| Route              | Cost   | Purpose                                     |
| ------------------ | ------ | ------------------------------------------- |
| `POST /v1/extract` | $0.01  | The product, gated by x402 v2               |
| `POST /mcp`        | $0.01  | Same product as the MCP tool `render_markdown` |
| `GET /v1/about`    | free   | The offer, in machine-readable form         |
| `GET /health`      | free   | Liveness                                    |
| `GET /`            | free   | Landing page                                |

## How the money actually moves

1. An agent calls `POST /v1/extract` with no payment header.
2. `@x402/hono` answers **402** with a `payment-required` header describing the
   price, the asset (USDC), the chain (Base mainnet, `eip155:8453`) and the
   recipient (`PAY_TO`).
3. The agent signs an EIP-3009 transfer authorization and retries with a
   `payment-signature` header.
4. The **authenticated Coinbase facilitator** at
   `https://api.cdp.coinbase.com/platform/v2/x402` verifies the signature and
   settles the transfer on-chain. USDC lands in `PAY_TO`.
5. The handler renders the page and returns the Markdown.

The public facilitator at `https://x402.org/facilitator` **only settles on
testnets**. Pointing a mainnet route at it produces perfectly valid-looking
402s that never turn into money and never create a Bazaar listing. This project
never references it.

## Discovery: how buyers find it

There is no registration form for the [x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar).
A listing is created by the **first payment that settles through the CDP
facilitator** carrying the discovery metadata declared in `src/discovery.ts`.
So you publish by buying from yourself once:

```bash
npm run self-pay
```

Confirm the `extension-responses` header on the reply reports `bazaar: success`.
The listing becomes searchable a few hours later.

A listing with no settled payment for 30 days is delisted, which is what the
weekly cron in `wrangler.jsonc` exists to prevent. It pays this service one cent
every Monday and no-ops unless `BUYER_PRIVATE_KEY` is set.

## Setup

```bash
npm install
```

Then edit `wrangler.jsonc` and replace `PAY_TO` with your own receiving address.
It ships as the zero address on purpose: the Worker refuses to serve the paid
route until you change it, rather than quietly paying a stranger.

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET

# Optional, only for `npm run self-pay` and the weekly keepalive.
# Use a throwaway wallet holding a couple of dollars of USDC on Base.
npx wrangler secret put BUYER_PRIVATE_KEY

npm run cf-typegen
npm run typecheck
npm run deploy
```

`routes` in `wrangler.jsonc` binds the Worker to `extract.anigok.com` as a
custom domain. If that hostname currently has a proxied `A`/`AAAA`/`CNAME`
record in Cloudflare DNS, delete it first — a stale proxied record pointing at a
dead origin is what produces `522 Connection timed out`, and a custom domain
route cannot coexist with it.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your CDP key
npm run dev                      # wrangler dev --remote
```

`--remote` is not optional. `env.BROWSER.quickAction()` is not implemented by
the local runtime, so purely local dev fails with
`The RPC receiver does not implement the method "quickAction"`. The
`"remote": true` flag on the browser binding in `wrangler.jsonc` covers the same
need.

## Calling it

```bash
# See the offer, free.
curl https://extract.anigok.com/v1/about

# Unpaid: returns 402 plus payment requirements.
curl -i -X POST https://extract.anigok.com/v1/extract \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

Paid, from a TypeScript client:

```ts
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const client = registerExactEvmScheme(new x402Client(), {
	signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
});

const res = await wrapFetchWithPayment(fetch, client)(
	"https://extract.anigok.com/v1/extract",
	{
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url: "https://example.com" }),
	}
);

console.log(await res.json());
```

As an MCP server, point any x402-aware MCP client at
`https://extract.anigok.com/mcp`. Call the free `about_render_markdown` tool
first to read the price and schema, then `render_markdown` to buy.

## Response shape

```json
{
	"ok": true,
	"url": "https://example.com/",
	"markdown": "# Example Domain\n\nThis domain is for use in ...",
	"chars": 218,
	"truncated": false,
	"sha256": "3b7a...",
	"retrievedAt": "2026-08-19T18:00:00.000Z",
	"browserMsUsed": 1420
}
```

Errors use the same envelope with `ok: false` and a stable machine-readable
`code`: `invalid_body`, `invalid_url`, `blocked_url`, `render_timeout`,
`render_failed`, `empty_result`, `server_misconfigured`,
`facilitator_unavailable`, `internal_error`.

## Files

```
src/index.ts       Hono app, routes, CORS, /mcp mount, cron entry, error envelope
src/env.ts         Environment contract (bindings from wrangler types + secrets)
src/extract.ts     URL validation, SSRF blocklist, Browser Run render, SHA-256
src/discovery.ts   Bazaar metadata and JSON Schemas — this is the listing
src/payments.ts    x402 v2 wiring: CDP facilitator, routes, startup construction
src/mcp.ts         ExtractMcp Durable Object: paid tool + free descriptor tool
src/keepalive.ts   Weekly self-payment so the listing is not dropped at 30 days
scripts/self-pay.ts  One-shot buyer that publishes the Bazaar listing
public/            Landing page and icon
```

## Two Workers-specific constraints this code is shaped around

Both were found by running it, and both fail quietly rather than loudly.

**1. The payment middleware is constructed at module scope, not per request.**
x402 validates the Bazaar route extension with Ajv, and Ajv builds validator
functions from strings. workerd only permits dynamic code generation during
module startup. Build the middleware inside a request handler and the compile
throws, x402 catches it, and the extension is **silently dropped**:

```
x402: Route "POST /v1/extract" has an invalid bazaar extension:
Schema validation failed: Code generation from strings disallowed
```

Payments still work, so the only visible symptom is that no Bazaar listing ever
appears. `src/payments.ts` therefore builds during startup, using
`import { env } from "cloudflare:workers"` to reach configuration there.

**2. That in turn forces `syncFacilitatorOnStart` off, and forces us to do the
sync ourselves.** Module scope forbids network I/O, but x402 cannot mint a 402
until the facilitator's supported payment kinds are cached:

```
Facilitator does not support exact on eip155:8453.
Make sure to call initialize() to fetch supported kinds from facilitators.
```

So `ensureFacilitatorReady()` awaits `server.initialize()` once on the first
request of each isolate, where I/O is legal, and clears its cached promise on
failure so the next request retries instead of being permanently poisoned.

## Safety

`src/extract.ts` rejects anything that is not `http:`/`https:`, plus localhost,
`*.localhost`, `*.internal`, `metadata.google.internal`, IPv4 loopback, private
(`10/8`, `172.16/12`, `192.168/16`), link-local `169.254/16` (cloud metadata),
carrier-grade NAT `100.64/10`, IPv6 loopback and unique-local, and URLs over
2048 characters. Rendered output is capped at 500,000 characters and the render
is bounded at 20 seconds.

## Costs

- CDP facilitator: first 1,000 on-chain settlements per month are free, then
  $0.001 each. Verification is always free.
- Browser Run and Workers bill per use; every response carries
  `X-Browser-Ms-Used` so you can watch unit economics per call.

At $0.01 per call, settlement is roughly 10% of revenue at worst and 0% inside
the free tier.
