/**
 * x402 v2 payment wiring.
 *
 * Two rules this file exists to enforce:
 *
 * 1. The facilitator is the AUTHENTICATED Coinbase facilitator at
 *    https://api.cdp.coinbase.com/platform/v2/x402. The public
 *    https://x402.org/facilitator only settles on testnets. Pointing a
 *    mainnet route at it produces 402s that never turn into money and never
 *    create a Bazaar listing.
 *
 * 2. Nothing here runs at module scope. Workers forbids I/O during global
 *    evaluation, and env is not available there anyway. The middleware is
 *    built on first request and memoized per isolate.
 */
import { createFacilitatorConfig } from "@coinbase/x402";
import { env } from "cloudflare:workers";
import {
	HTTPFacilitatorClient,
	type RoutesConfig,
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import {
	SERVICE_DESCRIPTION,
	SERVICE_TAGS,
	httpDiscoveryExtension,
} from "./discovery";
import type { Env } from "./env";

type Built = { middleware: MiddlewareHandler; server: x402ResourceServer };

/**
 * WHY THIS IS BUILT AT MODULE SCOPE.
 *
 * x402 validates a route's bazaar extension with Ajv, and Ajv compiles
 * validators by constructing functions from strings. workerd only permits
 * dynamic code generation during module startup; at request time it throws
 * `Code generation from strings disallowed for this context` and x402 responds
 * by silently DROPPING the extension:
 *
 *   x402: Route "POST /v1/extract" has an invalid bazaar extension:
 *   Schema validation failed: Code generation from strings disallowed
 *
 * Payments keep working, so the only symptom is that no Bazaar listing is ever
 * created and no agent ever discovers the service. Building the middleware here,
 * during startup, is what makes the Ajv compile legal. `env` at module scope
 * comes from `cloudflare:workers`.
 *
 * The one hard rule that comes with this: NO NETWORK I/O at module scope. That
 * is why syncFacilitatorOnStart is disabled and we drive the facilitator's
 * supported-kinds sync ourselves on the first request instead.
 */

/**
 * Fail fast and loudly on missing configuration rather than silently
 * degrading to an unpaid or testnet-only endpoint.
 *
 * @param env - Worker environment
 * @throws Error listing every missing or placeholder value
 */
function assertConfigured(env: Env): void {
	const problems: string[] = [];

	if (!env.CDP_API_KEY_ID) problems.push("CDP_API_KEY_ID secret is not set");
	if (!env.CDP_API_KEY_SECRET) {
		problems.push("CDP_API_KEY_SECRET secret is not set");
	}
	if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO ?? "")) {
		problems.push("PAY_TO is not a valid 0x address");
	}
	if (/^0x0{40}$/.test(env.PAY_TO ?? "")) {
		problems.push("PAY_TO is still the zero-address placeholder");
	}
	if (!env.NETWORK?.startsWith("eip155:")) {
		problems.push('NETWORK must be a CAIP-2 id such as "eip155:8453"');
	}
	if (!env.PRICE) problems.push("PRICE is not set");
	if (!env.SERVICE_ORIGIN?.startsWith("https://")) {
		problems.push("SERVICE_ORIGIN must be an https origin");
	}

	if (problems.length > 0) {
		throw new Error(`x402 misconfigured: ${problems.join("; ")}`);
	}
}

/**
 * Build the authenticated CDP facilitator client.
 *
 * @param env - Worker environment
 * @returns A facilitator client bound to the user's CDP credentials
 */
export function createFacilitator(env: Env): HTTPFacilitatorClient {
	return new HTTPFacilitatorClient(
		createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)
	);
}

/**
 * Route configuration for the paid HTTP endpoint, including the Bazaar
 * discovery extension that becomes the public listing.
 *
 * @param env - Worker environment
 * @returns x402 routes config keyed by method and path
 */
export function buildRoutes(env: Env): RoutesConfig {
	return {
		"POST /v1/extract": {
			accepts: [
				{
					scheme: "exact",
					payTo: env.PAY_TO,
					price: env.PRICE,
					network: env.NETWORK as Network,
					maxTimeoutSeconds: 120,
				},
			],
			// Absolute URL. Bazaar needs the real public resource, not a path.
			resource: `${env.SERVICE_ORIGIN}/v1/extract`,
			description: SERVICE_DESCRIPTION,
			mimeType: "application/json",
			serviceName: env.SERVICE_NAME,
			tags: SERVICE_TAGS,
			iconUrl: `${env.SERVICE_ORIGIN}/icon.svg`,
			extensions: httpDiscoveryExtension,
			// Shown to an agent that calls without paying, so it can decide.
			unpaidResponseBody: () => ({
				contentType: "application/json",
				body: {
					ok: false,
					error: "payment required",
					code: "payment_required",
					price: env.PRICE,
					network: env.NETWORK,
					docs: `${env.SERVICE_ORIGIN}/v1/about`,
				},
			}),
			settlementFailedResponseBody: () => ({
				contentType: "application/json",
				body: {
					ok: false,
					error: "payment settlement failed, nothing was charged",
					code: "settlement_failed",
				},
			}),
		},
	};
}

/**
 * Assemble the middleware. Startup-only; see the note at the top of the file.
 *
 * @param env - Worker environment
 * @returns Hono middleware that gates POST /v1/extract behind x402
 */
function build(env: Env): Built {
	assertConfigured(env);

	const server = new x402ResourceServer(createFacilitator(env))
		.register(env.NETWORK as Network, new ExactEvmScheme())
		.registerExtension(bazaarResourceServerExtension);

	// syncFacilitatorOnStart is the 5th positional arg and defaults to true,
	// which fires httpServer.initialize() the instant the middleware is
	// constructed. We construct during startup, where workerd forbids network
	// I/O, so it must be off.
	//
	// It cannot simply be skipped, though: buildPaymentRequirements refuses to
	// mint a 402 until the facilitator's supported kinds are cached, failing with
	// "Facilitator does not support exact on eip155:8453. Make sure to call
	// initialize()". So we own that sync: `ensureFacilitatorReady` below awaits
	// server.initialize() once, on the first request, where I/O is allowed.
	const middleware = paymentMiddleware(
		buildRoutes(env),
		server,
		undefined,
		undefined,
		false
	);

	return { middleware, server };
}

/**
 * Built once, during startup. Either the pieces or the reason there aren't any;
 * the route handler turns the latter into a 503 carrying an actionable message,
 * rather than letting the whole Worker fail to boot.
 */
const built: Built | { error: Error } = (() => {
	try {
		return build(env as unknown as Env);
	} catch (error) {
		return {
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
})();

let facilitatorReady: Promise<void> | null = null;

/**
 * Fetch and cache the facilitator's supported payment kinds. Idempotent, and
 * on failure it clears the cached promise so the next request retries instead
 * of being permanently poisoned.
 *
 * @returns Resolves once the resource server can mint payment requirements
 * @throws The startup configuration error, or a facilitator error
 */
export async function ensureFacilitatorReady(): Promise<void> {
	if ("error" in built) throw built.error;
	if (!facilitatorReady) {
		facilitatorReady = built.server.initialize().catch((error: unknown) => {
			facilitatorReady = null;
			throw error;
		}) as Promise<void>;
	}
	return facilitatorReady;
}

/**
 * Get the payment middleware built at startup.
 *
 * @returns Hono middleware that gates POST /v1/extract behind x402
 * @throws The startup configuration error, if there was one
 */
export function getPaymentMiddleware(): MiddlewareHandler {
	if ("error" in built) throw built.error;
	return built.middleware;
}
