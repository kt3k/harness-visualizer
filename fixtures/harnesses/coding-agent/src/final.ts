// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
export type FinalAnswer = { status: "done" | "blocked"; summary: string };

export function parseFinalAnswer(text: string): FinalAnswer | null {
  try {
    const value = JSON.parse(text);
    if ((value.status === "done" || value.status === "blocked") && typeof value.summary === "string") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}
