// Jev as the judge of which saved facts a message brings up, through TypeSafe's own client with its requests
// answered here instead of by api.typesafe.ai. Run from the repo root:  node --test test/jev.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevRelevance } from "../src/jev.ts";

type Question = { type: string; instructions: { question: string; saved_fact: string } };
type Body = { state: { message: string }; questions: Record<string, Question> };

// A client that hands each request's body to `respond`. Bodies stay uncompressed and nothing is retried, so a test sees every request once.
function clientWith(respond: (body: Body) => { status: number; body: unknown }) {
	const requests: Body[] = [];
	const client = new TypeSafeClient({
		apiKey: "test-key",
		compression: false,
		retry: { maxRetries: 0 },
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as Body;
			requests.push(body);
			const answer = respond(body);
			return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
		},
	});
	return { client, requests };
}

// Jev's answer to a request: 0.9 for a fact that mentions a plumber, 0.1 for any other.
const answered = (body: Body) => ({
	status: 200,
	body: {
		model: "jev-test",
		answers: Object.fromEntries(Object.entries(body.questions).map(([name, question]) => [name, { type: "noul", noul: question.instructions.saved_fact.includes("lumber") ? 0.9 : 0.1 }])),
		usage: { input_tokens: 1, output_tokens: 1 },
	},
});
const tooLong = { status: 400, body: { detail: { error_type: "max_tokens_exceeded" } } };

test("one request asks a yes/no question per fact about the message, and the probabilities come back in the facts' order", async () => {
	const { client, requests } = clientWith(answered);
	const relevance = createJevRelevance(client);
	assert.deepEqual(await relevance("when is the plumber coming", ["T-shirt size is XL", "Plumber comes Tuesday", "Timezone is Eastern", "The plumber is Joe"]), [0.1, 0.9, 0.1, 0.9]);
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0]?.state, { message: "when is the plumber coming" });
	const questions = Object.values(requests[0]?.questions ?? {});
	assert.deepEqual(questions.map((question) => [question.type, question.instructions.saved_fact]), [
		["noul", "T-shirt size is XL"],
		["noul", "Plumber comes Tuesday"],
		["noul", "Timezone is Eastern"],
		["noul", "The plumber is Joe"],
	]);
});

test("facts that don't fit one request are split across requests, still answered in order", async () => {
	const { client, requests } = clientWith((body) => (Object.keys(body.questions).length > 2 ? tooLong : answered(body)));
	const relevance = createJevRelevance(client);
	assert.deepEqual(await relevance("plumber?", ["Plumber one", "Plumber two", "Other three", "Other four", "Other five"]), [0.9, 0.9, 0.1, 0.1, 0.1]);
	assert.deepEqual(requests.map((body) => Object.keys(body.questions).length).sort(), [1, 2, 2, 3, 5], "5 and then 3 were too long; 2, 1 and 2 were answered");
});

test("a single fact too long for a request, or any other failure, is an error", async () => {
	const long = clientWith(() => tooLong);
	await assert.rejects(createJevRelevance(long.client)("plumber?", ["Plumber one"]), /max_tokens_exceeded/);
	assert.equal(long.requests.length, 1);

	const denied = clientWith(() => ({ status: 401, body: { detail: "bad key" } }));
	await assert.rejects(createJevRelevance(denied.client)("plumber?", ["Plumber one", "Other two"]), /401/);
	assert.equal(denied.requests.length, 1, "only a too-long request is split");
});
