/**
 * The Pi extension side of the chat-bridge template -- connects to the
 * already-running daemon (see daemon.ts, `bun run daemon`) over HTTP, the
 * Split deployment shape: the daemon keeps running and receiving webhooks
 * independent of whether this Pi session is even open.
 *
 * Configure CHAT_BRIDGE_URL/CHAT_BRIDGE_TOKEN to match wherever you're
 * actually running the daemon (see the root README's "Surviving a daemon
 * restart" section for a production-grade reconnecting client instead of
 * this template's bare RemoteVehicleClient).
 */
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { registerVehicleTools } from "@danypops/vehicle-client-pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", async () => {
		const baseUrl = process.env.CHAT_BRIDGE_URL ?? "http://127.0.0.1:8787";
		const token = process.env.CHAT_BRIDGE_TOKEN ?? "dev-token-replace-me";
		const client = new RemoteVehicleClient({ baseUrl, token });
		await registerVehicleTools(pi, client, { closeClientOnSessionShutdown: true });
	});
}
