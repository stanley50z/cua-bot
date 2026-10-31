// A fake Executor MCP server over pi-mcp's in-memory transport, shared by the executor and approval tests.
// It answers initialize and tools/call with `reply`, records every call, and keeps each session's server
// side so a test can drop it.
import { type CallToolResult, isJsonRpcRequest, McpClient } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";

export type Call = { name: string; args: Record<string, unknown> };

export function fakeExecutor(reply: (call: Call) => CallToolResult) {
	const calls: Call[] = [];
	const servers: InMemoryTransport[] = [];
	const connect = async () => {
		const { client: clientSide, server } = createInMemoryTransportPair();
		servers.push(server);
		server.onMessage((message) => {
			if (!isJsonRpcRequest(message)) return;
			const respond = (result: unknown) => void server.send({ jsonrpc: "2.0", id: message.id, result });
			if (message.method === "initialize") {
				return respond({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "executor", version: "test" } });
			}
			if (message.method === "tools/call") {
				const params = message.params as { name: string; arguments: Record<string, unknown> };
				const call = { name: params.name, args: params.arguments };
				calls.push(call);
				return respond(reply(call));
			}
		});
		await server.start();
		const client = new McpClient({ name: "test", version: "0" });
		await client.connect(clientSide);
		return client;
	};
	return { calls, servers, connect };
}

export const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** A base64 RFC 2822 message, the body of Executor's gmailUsersMessagesSend upload. */
export const rawEmail = (lines: string[]) => Buffer.from(lines.join("\r\n"), "utf8").toString("base64");
