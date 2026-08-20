/**
 * extract — a paid Markdown extraction endpoint on Cloudflare Workers.
 *
 *   POST /v1/extract   paid, x402, USDC on Base mainnet
 *   POST /mcp          same capability as a paid MCP tool
 *   GET  /v1/about     free, machine-readable offer description
 *   GET  /health       free
 *   GET  /             static landing page
 *
 * Money path: buyer sends x402 payment header -> the authenticated Coinbase
 * facilitator verifies and settles USDC on Base -> the first settled payment
 * publishes the Bazaar listing built from src/discovery.ts.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpAgent } from "agents/mcp";
import {
	MAX_MARKDOWN_CHARS,
	RENDER_TIMEOUT_MS,
	parseExtractRequest,
	renderMarkdown,
} from "./extract";
import {
	INPUT_SCHEMA,
	OUTPUT_EXAMPLE,
	OUTPUT_SCHEMA,
	SERVICE_DESCRIPTION,
	SERVICE_TAGS,
} from "./discovery";
import { ensureFacilitatorReady, getPaymentMiddleware } from "./payments";
import { runBazaarKeepalive } from "./keepalive";
import type { AppContext, Env } from "./env";

export { ExtractMcp } from "./mcp";

const app = new Hono<AppContext>();

app.use(
	"/v1/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"payment-signature",
			"x-payment",
			"accept",
		],
		exposeHeaders: [
			"payment-required",
			"payment-response",
			"extension-responses",
			"x-browser-ms-used",
		],
		maxAge: 86400,
	})
);

/** Free. Always answers, even when payment config is incomplete. */
app.get("/health", (c) =>
	c.json({
		ok: true,
		service: "extract",
		version: "1.0.0",
		time: new Date().toISOString(),
	})
);

/** Free. The offer, in the shape an agent can read without paying. */
app.get("/v1/about", (c) =>
	c.json({
		ok: true,
		service: c.env.SERVICE_NAME,
		description: SERVICE_DESCRIPTION,
		tags: SERVICE_TAGS,
		endpoint: `${c.env.SERVICE_ORIGIN}/v1/extract`,
		method: "POST",
		mcpEndpoint: `${c.env.SERVICE_ORIGIN}/mcp`,
		mcpTool: "render_markdown",
		protocol: { name: "x402", version: 2 },
		price: c.env.PRICE,
		asset: "USDC",
		network: c.env.NETWORK,
		payTo: c.env.PAY_TO,
		limits: {
			maxMarkdownChars: MAX_MARKDOWN_CHARS,
			renderTimeoutMs: RENDER_TIMEOUT_MS,
			maxUrlLength: 2048,
		},
		inputSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
		outputExample: OUTPUT_EXAMPLE,
	})
);

/**
 * Payment gate. Built lazily per isolate because Workers forbids I/O at
 * module scope and env is unavailable there.
 */
app.use("/v1/extract", async (c, next) => {
	let middleware;
	try {
		middleware = getPaymentMiddleware();
	} catch (error) {
		console.error("payment middleware unavailable", error);
		return c.json(
			{
				ok: false,
				code: "server_misconfigured",
				error: error instanceof Error ? error.message : String(error),
			},
			503
		);
	}

	// One network round trip on the first request of an isolate, then cached.
	// Without it x402 cannot build a 402 challenge at all. Distinguished from a
	// config problem so you can tell "my keys are wrong" from "CDP is down".
	try {
		await ensureFacilitatorReady();
	} catch (error) {
		console.error("facilitator unavailable", error);
		return c.json(
			{
				ok: false,
				code: "facilitator_unavailable",
				error: error instanceof Error ? error.message : String(error),
			},
			503
		);
	}

	return middleware(c, next);
});

/** Paid. Reached only after payment verification succeeds. */
app.post("/v1/extract", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ ok: false, code: "invalid_body", error: "body must be valid JSON" },
			400
		);
	}

	const parsed = parseExtractRequest(body);
	if (!parsed.ok) return c.json(parsed, 400);

	const result = await renderMarkdown(c.env, parsed.request);
	if (!result.ok) {
		return c.json(result, result.code === "render_timeout" ? 504 : 502);
	}

	return c.json(result, 200);
});

/** Paid MCP server, backed by the ExtractMcp Durable Object. */
const mcpHandler = McpAgent.serve("/mcp", { binding: "EXTRACT_MCP" });

app.all("/mcp", (c) =>
	mcpHandler.fetch(
		c.req.raw,
		c.env,
		c.executionCtx as unknown as ExecutionContext
	)
);

/** Everything else falls through to public/. */
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * Anything that escapes a handler. Buyers are programs, so never answer with
 * Hono's bare "Internal Server Error" string: emit the same JSON envelope as
 * every other error so a client can branch on `code`.
 */
app.onError((error, c) => {
	console.error("unhandled error", error);
	return c.json(
		{
			ok: false,
			code: "internal_error",
			error: error instanceof Error ? error.message : String(error),
		},
		500
	);
});

export default {
	fetch: app.fetch,

	/**
	 * Weekly Bazaar keepalive. A listing with no settled payment for 30 days
	 * is delisted, so the service buys from itself once a week.
	 *
	 * @param _controller - Cron trigger metadata
	 * @param env - Worker environment
	 * @param ctx - Execution context
	 */
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> {
		ctx.waitUntil(runBazaarKeepalive(env));
	},
} satisfies ExportedHandler<Env>;
