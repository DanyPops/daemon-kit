/**
 * Walking skeleton for a remote/chat-bridge daemon (the shape
 * @llblab/pi-telegram, pi-intercom, @gamalan/pi-gateway, and others all
 * hand-roll independently): one process serving two transports --
 * `chat.send` reachable as a Vehicle operation (so a Pi extension can call
 * it as a normal tool), and a plain inbound `/webhook` route (so the real
 * chat platform, e.g. Telegram/Discord/Slack, can deliver an incoming
 * message into the same process). This is the Split deployment shape
 * (daemon + HTTP), not Monolith -- a chat bridge must keep running and
 * receiving webhooks independent of whether any particular Pi session is
 * open. See the root README's "Split vs Monolith" section.
 *
 * Replace the in-memory sent/received logs with your real chat platform's
 * SDK call (chat.send's handler) and real webhook signature verification
 * (the /webhook route) before using this for anything real.
 */
import { bindVehicleOperation, defineVehicleEvent, defineVehicleOperation, defineVehicleSchema } from "@danypops/vehicle-core";
import { createVehicleHttpApp } from "@danypops/vehicle-server/http";
import { jsonResponse } from "@danypops/vehicle-server/rpc-http";
import { VehicleRegistry } from "@danypops/vehicle-server";

const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 4_096, maxResponseBytes: 65_536 };

export interface ChatMessage {
	readonly from: string;
	readonly text: string;
	readonly at: string;
}

const sendSchema = defineVehicleSchema<{ to: string; text: string }>({
	jsonSchema: {
		type: "object",
		properties: { to: { type: "string" }, text: { type: "string" } },
		required: ["to", "text"],
		additionalProperties: false,
	},
	safeParse(value) {
		const record = value as { to?: unknown; text?: unknown } | null;
		if (typeof record !== "object" || record === null || typeof record.to !== "string" || typeof record.text !== "string") {
			return { success: false, issues: [{ path: [], message: "to and text are both required strings" }] };
		}
		return { success: true, value: record as { to: string; text: string } };
	},
});

const jsonSchema = defineVehicleSchema<Record<string, unknown>>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value: (value ?? {}) as Record<string, unknown> }),
});

export const chatMessageReceivedEvent = defineVehicleEvent<ChatMessage>({
	name: "chat.message.received",
	version: 1,
	description: "A message arrived on the bridged chat platform's inbound webhook.",
	payload: defineVehicleSchema<ChatMessage>({
		jsonSchema: { type: "object" },
		safeParse: (value) => ({ success: true, value: value as ChatMessage }),
	}),
	maxPayloadBytes: 65_536,
});

export interface ChatBridgeState {
	readonly sent: ChatMessage[];
	readonly received: ChatMessage[];
}

/**
 * Registers chat.send/chat.history and the chat.message.received event
 * against `registry` -- factored out so both the real daemon entrypoint
 * below and this skeleton's own test suite build the identical registry.
 */
export function registerChatOperations(registry: VehicleRegistry): ChatBridgeState {
	const state: ChatBridgeState = { sent: [], received: [] };
	registry.registerEvent("chat-bridge", chatMessageReceivedEvent);

	const sendOperation = defineVehicleOperation({
		name: "chat.send",
		version: 1,
		description: "Sends a message on the bridged chat platform. Replace the body with your real platform SDK call.",
		input: sendSchema,
		output: jsonSchema,
		permissions: [],
		effect: "external-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		"chat-bridge",
		bindVehicleOperation(sendOperation, () => async (context) => {
			state.sent.push({ from: "bot", text: context.input.text, at: new Date().toISOString() });
			return { sent: true, to: context.input.to };
		}),
	);

	const historyOperation = defineVehicleOperation({
		name: "chat.history",
		version: 1,
		description: "Lists messages sent and received so far in this process.",
		input: jsonSchema,
		output: jsonSchema,
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		"chat-bridge",
		bindVehicleOperation(historyOperation, () => async () => ({ sent: [...state.sent], received: [...state.received] })),
	);

	return state;
}

/**
 * The second transport: a plain (non-Vehicle) inbound route on the exact
 * same server the Vehicle wire protocol is served from. A real chat
 * platform's webhook would POST here; this skeleton accepts
 * {from, text} directly for testability. Verify your real platform's
 * webhook signature here before trusting the body.
 */
export function createChatBridgeApp(
	registry: VehicleRegistry,
	state: ChatBridgeState,
	token: string,
): { fetch(request: Request): Promise<Response> } {
	const vehicleApp = createVehicleHttpApp({ registry, token });
	return {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/webhook") {
				let body: { from?: unknown; text?: unknown };
				try {
					body = (await request.json()) as { from?: unknown; text?: unknown };
				} catch {
					return jsonResponse({ error: "invalid JSON body" }, { status: 400 });
				}
				if (typeof body.from !== "string" || typeof body.text !== "string") {
					return jsonResponse({ error: "from and text are both required strings" }, { status: 400 });
				}
				const message: ChatMessage = { from: body.from, text: body.text, at: new Date().toISOString() };
				state.received.push(message);
				registry.emit(chatMessageReceivedEvent.descriptor.name, chatMessageReceivedEvent.descriptor.version, message);
				return jsonResponse({ received: true });
			}
			return vehicleApp.fetch(request);
		},
	};
}

if (import.meta.main) {
	const registry = new VehicleRegistry({ name: "chat-bridge-template", version: "1.0.0", description: "Chat bridge walking skeleton." });
	const state = registerChatOperations(registry);
	const token = process.env.CHAT_BRIDGE_TOKEN ?? "dev-token-replace-me";
	const app = createChatBridgeApp(registry, state, token);
	const port = Number(process.env.CHAT_BRIDGE_PORT ?? 8787);
	Bun.serve({ port, fetch: app.fetch });
	console.log(`chat-bridge daemon listening on :${port} (Vehicle at /vehicle/*, webhook at /webhook)`);
}
