// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { openai } from "./llm";
import { TokenBudget } from "./budget";

const MAX_DEPTH = 2;
const MAX_STEPS = 6;
const ALLOWED_HOSTS = ["en.wikipedia.org", "arxiv.org", "docs.example.org"];

const RESEARCHER_PROMPT = `You research one question using web_search and fetch_url.
Cite every source URL. Only fetch pages from allowed documentation hosts.
Never submit forms or log in to websites.
If the question is too broad, use spawn_subresearch for a narrower sub-question.`;

const RESEARCH_TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } } } } },
  { type: "function", function: { name: "fetch_url", description: "Fetch a web page.", parameters: { type: "object", properties: { url: { type: "string" } } } } },
  { type: "function", function: { name: "spawn_subresearch", description: "Research a narrower sub-question.", parameters: { type: "object", properties: { question: { type: "string" } } } } },
];

export async function runResearcher(question: string, depth: number, budget: TokenBudget, signal: AbortSignal): Promise<string> {
  const messages: any[] = [
    { role: "system", content: RESEARCHER_PROMPT },
    { role: "user", content: question },
  ];
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) {
      throw new Error("research cancelled");
    }
    const completion = await openai.chat.completions.create({ model: "gpt-4.1", messages, tools: RESEARCH_TOOLS }, { signal });
    budget.consume(completion.usage.total_tokens);
    const msg = completion.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content;
    }
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      let result: string;
      if (call.function.name === "web_search") {
        const res = await fetch(`https://search.example.com/api?q=${encodeURIComponent(args.query)}`, { signal });
        result = await res.text();
      } else if (call.function.name === "fetch_url") {
        const host = new URL(args.url).hostname;
        if (!ALLOWED_HOSTS.includes(host)) {
          result = `error: host not allowed: ${host}`;
        } else {
          const page = await fetch(args.url, { signal });
          result = (await page.text()).slice(0, 20_000);
        }
      } else if (call.function.name === "spawn_subresearch") {
        if (depth >= MAX_DEPTH) {
          result = "error: maximum research depth reached";
        } else {
          result = await runResearcher(args.question, depth + 1, budget, signal);
        }
      } else {
        result = `error: unknown tool ${call.function.name}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return "incomplete: step budget exhausted";
}
