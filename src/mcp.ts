/**
 * The same product exposed as a paid MCP tool at /mcp.
 *
 * The HTTP route sells to agents that speak x402 over HTTP. This sells to
 * agents that speak MCP. Same code path, same price, one deployment.
 */
import { McpAgent } from "agents/mcp";
import { withX402 } from "agents/x402";
import { createFacilitatorConfig } from "@coinbase/x402";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	MAX_MARKDOWN_CHARS,
	parseExtractRequest,
	renderMarkdown,
} from "./extract";
import { OUTPUT_EXAMPLE, SERVICE_DESCRIPTION } from "./discovery";
import type { Env } from "./env";

/** Tool description, kept under the Bazaar 500-character limit. */
const TOOL_DESCRIPTION =
	"Convert a public web page to clean Markdown. Renders JavaScript with a real headless browser, then returns deterministic Markdown plus a SHA-256 of the exact bytes and an ISO retrieval timestamp so the result is verifiable and cacheable.";

export class ExtractMcp extends McpAgent<Env> {
	server = new McpServer({
		name: "extract",
		version: "1.0.0",
	});

	/**
	 * Register the free descriptor tool and the paid extraction tool.
	 */
	async init(): Promise<void> {
		const env = this.env;

		// Free tool. Lets an agent understand the offer before spending money.
		this.server.registerTool(
			"about_render_markdown",
			{
				description:
					"Free. Describes the render_markdown tool: price, network, input shape, output shape, and limits. Call this first.",
				inputSchema: {},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async () => ({
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								tool: "render_markdown",
								description: SERVICE_DESCRIPTION,
								price: env.PRICE,
								network: env.NETWORK,
								payTo: env.PAY_TO,
								maxMarkdownChars: MAX_MARKDOWN_CHARS,
								input: { url: "https://example.com", waitUntil: "networkidle2" },
								outputExample: OUTPUT_EXAMPLE,
								httpEquivalent: `${env.SERVICE_ORIGIN}/v1/extract`,
							},
							null,
							2
						),
					},
				],
			})
		);

		const paid = withX402(this.server, {
			network: env.NETWORK,
			recipient: env.PAY_TO as `0x${string}`,
			facilitator: createFacilitatorConfig(
				env.CDP_API_KEY_ID,
				env.CDP_API_KEY_SECRET
			),
		});

		paid.paidTool(
			"render_markdown",
			TOOL_DESCRIPTION,
			priceUsd(env.PRICE),
			{
				url: z.string().url().describe("Public http(s) URL to convert."),
				waitUntil: z
					.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
					.optional()
					.describe("Page load condition. networkidle0 for heavy SPAs."),
			},
			{ readOnlyHint: true, openWorldHint: true },
			async ({ url, waitUntil }) => {
				const parsed = parseExtractRequest({ url, waitUntil });
				if (!parsed.ok) {
					return {
						isError: true,
						content: [
							{ type: "text" as const, text: JSON.stringify(parsed) },
						],
					};
				}

				const result = await renderMarkdown(env, parsed.request);
				if (!result.ok) {
					return {
						isError: true,
						content: [
							{ type: "text" as const, text: JSON.stringify(result) },
						],
					};
				}

				return {
					content: [
						{ type: "text" as const, text: result.markdown },
						{
							type: "text" as const,
							text: JSON.stringify({
								url: result.url,
								chars: result.chars,
								truncated: result.truncated,
								sha256: result.sha256,
								retrievedAt: result.retrievedAt,
							}),
						},
					],
				};
			}
		);
	}
}

/**
 * Convert a "$0.01" style price string into the number paidTool expects.
 *
 * @param price - Price string, with or without a leading dollar sign
 * @returns The price as a number of USD
 */
function priceUsd(price: string): number {
	const value = Number(String(price).replace(/[^0-9.]/g, ""));
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`PRICE is not a positive amount: ${price}`);
	}
	return value;
}
