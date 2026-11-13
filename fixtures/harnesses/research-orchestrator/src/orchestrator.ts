// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import { writeFile } from "node:fs/promises";
import { openai } from "./llm";
import { TokenBudget } from "./budget";
import { runResearcher } from "./researcher";

const MAX_SUBTASKS = 4;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_LIMIT = 400_000;

const PLANNER_PROMPT = `Split the research request into at most 4 independent sub-questions.
Respond with JSON: {"questions": string[]}.`;

const SYNTHESIS_PROMPT = `Write a report that answers the request using only the findings provided.
Do not include claims that are not supported by a cited finding.`;

export async function runResearch(request: string, outPath: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const budget = new TokenBudget(TOKEN_LIMIT);
  try {
    const plan = await openai.chat.completions.create({
      model: "gpt-4.1",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLANNER_PROMPT },
        { role: "user", content: request },
      ],
    });
    const questions: string[] = JSON.parse(plan.choices[0].message.content).questions.slice(0, MAX_SUBTASKS);

    const settled = await Promise.allSettled(
      questions.map((q) => runResearcher(q, 0, budget, controller.signal)),
    );
    const findings = settled.map((s, i) => (s.status === "fulfilled" ? `## ${questions[i]}\n${s.value}` : `## ${questions[i]}\n(failed: ${s.reason})`));

    const report = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: SYNTHESIS_PROMPT },
        { role: "user", content: `${request}\n\n${findings.join("\n\n")}` },
      ],
    });
    await writeFile(outPath, report.choices[0].message.content);
    return outPath;
  } finally {
    clearTimeout(timer);
  }
}
