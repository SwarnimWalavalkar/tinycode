/** Request complete Chat Completions to avoid Workers AI's broken streaming
 * tool boundaries. Adapt typed results to Pi's parser; never execute thought text.
 * Pi still owns history, the agent loop, tool validation, and execution. */
export const workersAiFetch: typeof fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body));
  delete body.stream_options;
  const response = await fetch(input, {
    ...init,
    body: JSON.stringify({ ...body, stream: false }),
  });
  if (!response.ok) return response;
  const result = await response.json() as {
    id: string; created: number; model: string; usage?: unknown;
    choices: { index: number; message: { reasoning_content?: string; tool_calls?: Record<string, unknown>[] }; finish_reason: string }[];
  };
  if (!Array.isArray(result.choices) || !result.choices.length)
    throw new Error("Workers AI returned an invalid completion");
  const chunk = (choices: unknown[], usage?: unknown) => ({
    id: result.id, created: result.created, model: result.model,
    object: "chat.completion.chunk", choices, ...(usage ? { usage } : {}),
  });
  const events = [chunk(result.choices.map(choice => ({
    index: choice.index,
    delta: { reasoning_content: choice.message.reasoning_content ?? "" },
    finish_reason: null,
  }))), chunk(result.choices.map(choice => ({
    index: choice.index,
    delta: { ...choice.message, reasoning_content: undefined, ...(choice.message.tool_calls ? {
      tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool, index })),
    } : {}) },
    finish_reason: null,
  }))), chunk(result.choices.map(choice => ({
    index: choice.index, delta: {}, finish_reason: choice.finish_reason,
  })), result.usage)];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
};
