/**
 * Environment contract for the extract Worker.
 *
 * Bindings and plaintext `vars` come from wrangler.jsonc and are generated
 * into `Cloudflare.Env` by `npm run cf-typegen`. Regenerate after every
 * wrangler.jsonc change so the compiler catches drift instead of production
 * catching it.
 *
 * Generated members:
 *   BROWSER        BrowserRun               Browser Run, quickAction, no API token
 *   ASSETS         Fetcher                  static files in public/
 *   EXTRACT_MCP    DurableObjectNamespace   backs the MCP server at /mcp
 *   NETWORK        string                   CAIP-2 id, "eip155:8453" for Base
 *   PRICE          string                   per-call price, "$0.01"
 *   PAY_TO         string                   your USDC receiving address on Base
 *   SERVICE_ORIGIN string                   public https origin
 *   SERVICE_NAME   string                   Bazaar serviceName
 *
 * Secrets are declared below and set with `wrangler secret put <NAME>`.
 */
export interface Env extends Cloudflare.Env {
	/** CDP API key id. Authenticates the Coinbase x402 facilitator. */
	CDP_API_KEY_ID: string;
	/** CDP API key secret. */
	CDP_API_KEY_SECRET: string;
	/**
	 * Optional. Private key of a throwaway, lightly funded Base wallet used by
	 * `npm run self-pay` and by the weekly Bazaar keepalive cron. Leave unset
	 * and the keepalive no-ops.
	 */
	BUYER_PRIVATE_KEY?: string;
}

export type AppContext = { Bindings: Env };
