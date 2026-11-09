// Jev, TypeSafe AI's decision model, as the judge of which saved facts and work-log records an incoming message
// brings up: the `relevance` that createMemory takes. main.ts makes one when TYPESAFE_API_KEY is set. From then on
// every message from the owner or another bot goes to api.typesafe.ai together with the log facts the receiving
// bot's memory section doesn't show and the records of that bot's work log, and Jev answers with the probability
// that each bears on the message. It generates no text. The key, base URL and model come from TYPESAFE_API_KEY,
// TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL; the client's own defaults apply to the rest: 10 seconds per attempt
// and two retries.
import { BadRequestError, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Relevance } from "./memory.ts";

// The yes/no question asked about one saved fact or work-log record. `message` is the request's state.
const question = (fact: string) =>
	noul(
		{ question: "Would knowing `saved_fact` change or inform how the assistant should answer or act on `message`?", saved_fact: fact },
		{
			true: "`saved_fact` is about the same specific item, person, event or decision that `message` is about",
			false: "`saved_fact` is about something else, or `message` is too general to tell that it concerns `saved_fact`",
		},
	);

// Jev's refusal of a request over its context length, about 32,000 tokens for the message and every question together.
const tooLong = (error: unknown) => error instanceof BadRequestError && (error.body as { detail?: { error_type?: unknown } } | null)?.detail?.error_type === "max_tokens_exceeded";

/** The judge for createMemory's `relevance`: one request per message, split in half for as long as Jev says a request is too long. */
export function createJevRelevance(client: Pick<TypeSafeClient, "systemOne"> = new TypeSafeClient()): Relevance {
	const relevance: Relevance = async (message, facts) => {
		try {
			const { answers } = await client.systemOne({ state: { message }, questions: Object.fromEntries(facts.map((fact, index) => [`fact${index}`, question(fact)])) });
			return facts.map((_, index) => (answers[`fact${index}`] as { noul: number }).noul);
		} catch (error) {
			if (!tooLong(error) || facts.length < 2) throw error;
			const half = Math.ceil(facts.length / 2);
			return (await Promise.all([relevance(message, facts.slice(0, half)), relevance(message, facts.slice(half))])).flat();
		}
	};
	return relevance;
}
