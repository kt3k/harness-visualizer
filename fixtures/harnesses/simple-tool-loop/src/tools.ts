// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.

export const WEATHER_TOOLS = [
  {
    name: "get_weather",
    description: "Get current weather for a city.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  {
    name: "convert_units",
    description: "Convert a temperature between celsius and fahrenheit.",
    input_schema: {
      type: "object",
      properties: { value: { type: "number" }, to: { enum: ["C", "F"] } },
      required: ["value", "to"],
    },
  },
];

export async function runTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "get_weather": {
      if (typeof input.city !== "string" || input.city.length > 80) {
        return "error: invalid city";
      }
      const res = await fetch(
        `https://api.weather.example/v1/current?city=${encodeURIComponent(input.city)}`,
      );
      return await res.text();
    }
    case "convert_units": {
      const v = Number(input.value);
      return input.to === "F" ? String((v * 9) / 5 + 32) : String(((v - 32) * 5) / 9);
    }
    default:
      return `error: unknown tool ${name}`;
  }
}
