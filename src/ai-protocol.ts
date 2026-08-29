import type { AiMessage } from "./domain.js";
import { normalizeBaseUrl } from "./utils.js";

export const AI_PROVIDER_PROTOCOLS = ["openai-chat-completions", "openai-responses", "anthropic-messages", "google-vertex"] as const;
export type AiProviderProtocol = (typeof AI_PROVIDER_PROTOCOLS)[number];
export const AI_THINKING_TYPES = ["enabled", "adaptive"] as const;
export type AiThinkingType = (typeof AI_THINKING_TYPES)[number];
export const MAX_TOKENS_PARAMETERS = ["max_tokens", "max_completion_tokens"] as const;
export type MaxTokensParameter = (typeof MAX_TOKENS_PARAMETERS)[number];

export type AiProviderProtocolOption = {
  value: AiProviderProtocol;
  label: string;
  defaultBaseUrl: string;
  credentialKind: "api-key" | "service-account-json";
  supportsMultimodal: boolean;
  supportsMaxCompletionTokens: boolean;
};

export const AI_PROVIDER_PROTOCOL_OPTIONS: readonly AiProviderProtocolOption[] = Object.freeze([
  {
    value: "openai-chat-completions",
    label: "OpenAI Chat Completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    credentialKind: "api-key",
    supportsMultimodal: true,
    supportsMaxCompletionTokens: true
  },
  {
    value: "openai-responses",
    label: "OpenAI Responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    credentialKind: "api-key",
    supportsMultimodal: true,
    supportsMaxCompletionTokens: false
  },
  {
    value: "anthropic-messages",
    label: "Anthropic Messages",
    defaultBaseUrl: "https://api.anthropic.com",
    credentialKind: "api-key",
    supportsMultimodal: true,
    supportsMaxCompletionTokens: false
  },
  {
    value: "google-vertex",
    label: "Google Vertex",
    defaultBaseUrl: "https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi",
    credentialKind: "service-account-json",
    supportsMultimodal: true,
    supportsMaxCompletionTokens: true
  }
]);

export function isAiProviderProtocol(value: string): value is AiProviderProtocol {
  return (AI_PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

export function usesOpenAiChatCompletionsShape(protocol: AiProviderProtocol): boolean {
  return protocol === "openai-chat-completions" || protocol === "google-vertex";
}

export function usesOpenAiResponsesShape(protocol: AiProviderProtocol): boolean {
  return protocol === "openai-responses";
}

export function providerProtocolLabelText(protocol: AiProviderProtocol): string {
  return AI_PROVIDER_PROTOCOL_OPTIONS.find((option) => option.value === protocol)?.label ?? "AI provider";
}

export type CompletionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: unknown;
  };
};

export type CompletionMessageContent = string | Array<Record<string, unknown>>;

type AnthropicReplayContentBlock = Record<string, unknown>;

export type CompletionMessage = AiMessage | {
  role: "user";
  content: CompletionMessageContent;
} | {
  role: "assistant";
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: CompletionToolCall[];
  anthropic_content?: AnthropicReplayContentBlock[];
} | {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export type CompletionPayload = {
  usage?: Record<string, unknown>;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: CompletionToolCall[];
      anthropic_content?: AnthropicReplayContentBlock[];
    };
  }>;
};

export function normalizeProviderBaseUrl(value: string): string {
  return normalizeBaseUrl(value).replace(/\/(?:messages|responses)$/u, "");
}

function appendVersionedResource(baseUrl: string, resource: string): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  return /\/v1$/u.test(normalized) ? `${normalized}/${resource}` : `${normalized}/v1/${resource}`;
}

export function providerCompletionEndpoint(baseUrl: string, protocol: AiProviderProtocol): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (protocol === "anthropic-messages") return appendVersionedResource(normalized, "messages");
  if (protocol === "openai-responses") return appendVersionedResource(normalized, "responses");
  return `${normalized}/chat/completions`;
}

export function providerEmbeddingEndpoint(baseUrl: string): string {
  return appendVersionedResource(baseUrl, "embeddings");
}

export function providerLegacyCompletionEndpoint(baseUrl: string): string {
  return appendVersionedResource(baseUrl, "completions");
}

export function providerModelEndpoints(baseUrl: string, protocol: AiProviderProtocol): string[] {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (usesOpenAiChatCompletionsShape(protocol) || usesOpenAiResponsesShape(protocol)) return [`${normalized}/models`];
  const primary = appendVersionedResource(normalized, "models");
  const root = new URL("/v1/models", normalized).toString();
  return primary === root ? [primary] : [primary, root];
}

export type ProviderModelListItem = {
  modelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  multimodalEnabled?: boolean;
};

export type ProviderModelListPage = {
  models: ProviderModelListItem[];
  invalidItemCount: number;
  nextCursor?: string;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function trimmedString(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length <= maximumLength ? normalized : "";
}

function boundedPositiveInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.round(value);
  return normalized >= minimum && normalized <= maximum ? normalized : undefined;
}

function parseOpenAiCompatibleModelList(data: unknown[]): Pick<ProviderModelListPage, "models" | "invalidItemCount"> {
  let invalidItemCount = 0;
  const models = data.flatMap((item) => {
    const model = objectValue(item);
    const modelId = trimmedString(model?.id, 300);
    if (!model || !modelId) {
      invalidItemCount += 1;
      return [];
    }
    return [{ modelId, displayName: modelId }];
  });
  return { models, invalidItemCount };
}

function parseAnthropicModelList(data: unknown[]): Pick<ProviderModelListPage, "models" | "invalidItemCount"> {
  let invalidItemCount = 0;
  const models = data.flatMap((item) => {
    const model = objectValue(item);
    const modelId = trimmedString(model?.id, 300);
    if (!model || !modelId) {
      invalidItemCount += 1;
      return [];
    }
    const displayName = trimmedString(model.display_name, 200) || modelId;
    const capabilities = objectValue(model.capabilities);
    const imageInput = objectValue(capabilities?.image_input);
    const contextWindow = boundedPositiveInteger(model.max_input_tokens, 32_768, 2_000_000);
    const maxOutputTokens = boundedPositiveInteger(model.max_tokens, 1, 2_000_000);
    return [{
      modelId,
      displayName,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(typeof imageInput?.supported === "boolean" ? { multimodalEnabled: imageInput.supported } : {})
    }];
  });
  return { models, invalidItemCount };
}

export function parseProviderModelListPage(protocol: AiProviderProtocol, payload: unknown): ProviderModelListPage {
  const root = objectValue(payload);
  if (!root || !Array.isArray(root.data)) {
    throw new Error(`${providerProtocolLabelText(protocol)} /models 响应缺少 data 列表`);
  }
  if (protocol === "anthropic-messages") {
    const page = parseAnthropicModelList(root.data);
    if (root.has_more !== true) return page;
    const nextCursor = trimmedString(root.last_id, 300);
    if (!nextCursor) throw new Error("Anthropic Messages /models 分页响应缺少 last_id");
    return { ...page, nextCursor };
  }
  return parseOpenAiCompatibleModelList(root.data);
}

export function providerModelListPageEndpoint(
  endpoint: string,
  protocol: AiProviderProtocol,
  cursor?: string
): string {
  if (protocol !== "anthropic-messages") return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set("limit", "1000");
  if (cursor) url.searchParams.set("after_id", cursor);
  return url.toString();
}

export function providerRequestHeaders(
  protocol: AiProviderProtocol,
  accessToken: string,
  accept: "application/json" | "text/event-stream"
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(protocol === "anthropic-messages" ? { "x-api-key": accessToken, "anthropic-version": "2023-06-01" } : {}),
    "Content-Type": "application/json",
    Accept: accept
  };
}

function textContent(value: CompletionMessageContent | null | undefined): Array<Record<string, unknown>> {
  if (typeof value === "string") return value.length > 0 ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((block) => block.type === "text" && typeof block.text === "string");
}

function anthropicContentBlocks(value: CompletionMessageContent | null | undefined): Array<Record<string, unknown>> {
  if (typeof value === "string") return textContent(value);
  if (!Array.isArray(value)) return [];
  const translated = value.flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "image" && block.source && typeof block.source === "object" && !Array.isArray(block.source)) {
      return [structuredClone(block)];
    }
    if (block.type !== "image_url" || !block.image_url || typeof block.image_url !== "object" || Array.isArray(block.image_url)) return [];
    const imageUrl = block.image_url as Record<string, unknown>;
    if (typeof imageUrl.url !== "string" || imageUrl.url.length === 0) return [];
    const dataUrl = imageUrl.url.match(/^data:([^;,]+);base64,(.*)$/u);
    return [{
      type: "image",
      source: dataUrl
        ? { type: "base64", media_type: dataUrl[1], data: dataUrl[2] }
        : { type: "url", url: imageUrl.url }
    }];
  });
  // Anthropic 官方建议先放图片再放文本；保留各自的相对顺序，兼容对块顺序敏感的代理。
  return [
    ...translated.filter((block) => block.type === "image"),
    ...translated.filter((block) => block.type !== "image")
  ];
}

function responseInputContent(value: CompletionMessageContent | null | undefined): Array<Record<string, unknown>> {
  if (typeof value === "string") return textContent(value).map((block) => ({ type: "input_text", text: block.text }));
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "input_text", text: block.text }];
    if (block.type === "input_text" && typeof block.text === "string") return [structuredClone(block)];
    if (block.type === "input_image" && (typeof block.image_url === "string" || typeof block.file_id === "string")) return [structuredClone(block)];
    if (block.type !== "image_url" || !block.image_url || typeof block.image_url !== "object" || Array.isArray(block.image_url)) return [];
    const imageUrl = block.image_url as Record<string, unknown>;
    if (typeof imageUrl.url !== "string" || imageUrl.url.length === 0) return [];
    return [{
      type: "input_image",
      image_url: imageUrl.url,
      ...(typeof imageUrl.detail === "string" ? { detail: imageUrl.detail } : {})
    }];
  });
}

function parsedToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function anthropicAssistantContent(message: {
  content: string | null;
  tool_calls?: CompletionToolCall[];
  anthropic_content?: AnthropicReplayContentBlock[];
}): Array<Record<string, unknown>> {
  if (Array.isArray(message.anthropic_content) && message.anthropic_content.length > 0) {
    return structuredClone(message.anthropic_content);
  }
  return [
    ...textContent(message.content),
    ...(message.tool_calls ?? []).map((toolCall) => ({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parsedToolInput(toolCall.function.arguments)
    }))
  ];
}

function anthropicToolResult(message: Extract<CompletionMessage, { role: "tool" }>): Record<string, unknown> {
  let isError = false;
  try {
    const result = JSON.parse(message.content) as Record<string, unknown>;
    isError = result.ok === false;
  } catch {
    isError = false;
  }
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    content: message.content,
    ...(isError ? { is_error: true } : {})
  };
}

function anthropicMessages(messages: CompletionMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }>;
} {
  const system = messages
    .filter((message): message is AiMessage & { role: "system" } => message.role === "system")
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  const output: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];
  const append = (role: "user" | "assistant", content: Array<Record<string, unknown>>): void => {
    if (content.length === 0) return;
    const previous = output.at(-1);
    if (previous?.role !== role) {
      output.push({ role, content });
      return;
    }
    const merged = [...previous.content, ...content];
    previous.content = merged.some((block) => block.type === "image")
      ? [
        ...merged.filter((block) => block.type === "image"),
        ...merged.filter((block) => block.type !== "image")
      ]
      : merged;
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      append("user", [anthropicToolResult(message)]);
      continue;
    }
    if (message.role === "assistant") {
      append("assistant", anthropicAssistantContent(message));
      continue;
    }
    append(message.role, anthropicContentBlocks(message.content));
  }
  return { ...(system ? { system } : {}), messages: output };
}

function serializedToolArguments(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

function responsesInput(messages: CompletionMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      output.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
      continue;
    }
    const content = responseInputContent(message.content);
    if (content.length > 0) output.push({ type: "message", role: message.role, content });
    if (message.role === "assistant" && "tool_calls" in message) {
      for (const toolCall of message.tool_calls ?? []) {
        output.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: serializedToolArguments(toolCall.function.arguments)
        });
      }
    }
  }
  return output;
}

function anthropicTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  return tools.flatMap((tool) => {
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
      ? tool.function as Record<string, unknown>
      : null;
    if (!fn || typeof fn.name !== "string") return [];
    return [{
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema: fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} }
    }];
  });
}

function responsesTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  return tools.flatMap((tool) => {
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
      ? tool.function as Record<string, unknown>
      : null;
    if (!fn || typeof fn.name !== "string") return [];
    return [{
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters: fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} }
    }];
  });
}

export function buildCompletionRequestBody(input: {
  protocol: AiProviderProtocol;
  model: string;
  messages: CompletionMessage[];
  parameters: Record<string, unknown>;
  maxTokensParameter?: MaxTokensParameter;
  tools?: Record<string, unknown>[];
  toolChoice?: "auto" | "none";
  stream?: boolean;
}): Record<string, unknown> {
  const tools = input.toolChoice === "auto" ? input.tools ?? [] : [];
  if (usesOpenAiResponsesShape(input.protocol)) {
    const parameters = { ...input.parameters };
    const maxTokens = parameters.max_tokens ?? parameters.max_completion_tokens;
    delete parameters.max_tokens;
    delete parameters.max_completion_tokens;
    if (typeof maxTokens === "number") parameters.max_output_tokens = maxTokens;
    const reasoningEffort = parameters.reasoning_effort;
    delete parameters.reasoning_effort;
    if (typeof reasoningEffort === "string") parameters.reasoning = { effort: reasoningEffort };
    delete parameters.thinking;
    delete parameters.output_config;
    return {
      model: input.model,
      input: responsesInput(input.messages),
      ...parameters,
      ...(tools.length > 0 ? { tools: responsesTools(tools), tool_choice: "auto" } : {}),
      ...(input.stream ? { stream: true } : {})
    };
  }
  if (usesOpenAiChatCompletionsShape(input.protocol)) {
    const parameters = { ...input.parameters };
    if (input.maxTokensParameter === "max_completion_tokens") {
      const maxTokens = parameters.max_tokens;
      delete parameters.max_tokens;
      if (typeof maxTokens === "number") parameters.max_completion_tokens = maxTokens;
    }
    return {
      model: input.model,
      messages: input.messages.map((message) => {
        if (message.role !== "assistant" || !("anthropic_content" in message)) return message;
        const { anthropic_content: _anthropicContent, ...openAiMessage } = message;
        return openAiMessage;
      }),
      ...parameters,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      ...(input.stream ? { stream: true, stream_options: { include_usage: true } } : {})
    };
  }
  const translated = anthropicMessages(input.messages);
  const parameters = Object.fromEntries(Object.entries(input.parameters)
    .filter(([key]) => ["temperature", "top_p", "max_tokens", "thinking", "output_config"].includes(key)));
  return {
    model: input.model,
    ...translated,
    ...parameters,
    ...(tools.length > 0 ? { tools: anthropicTools(tools), tool_choice: { type: "auto" } } : {}),
    ...(input.stream ? { stream: true } : {})
  };
}

function replayableAnthropicBlock(value: unknown): AnthropicReplayContentBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature };
  }
  if (block.type === "redacted_thinking" && typeof block.data === "string") {
    return { type: "redacted_thinking", data: block.data };
  }
  if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
    return { type: "tool_use", id: block.id, name: block.name, input: parsedToolInput(block.input) };
  }
  return null;
}

function anthropicFinishReason(value: unknown): string | null {
  if (value === "max_tokens") return "length";
  return typeof value === "string" ? value : null;
}

function parseResponsesPayload(value: unknown): CompletionPayload {
  const response = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const output = Array.isArray(response.output) ? response.output : [];
  const outputText = typeof response.output_text === "string" ? response.output_text : "";
  let text = outputText;
  let reasoning = "";
  const toolCalls: CompletionToolCall[] = [];
  for (const value of output) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      if (!text) {
        text = content.flatMap((part) => {
          if (!part || typeof part !== "object" || Array.isArray(part)) return [];
          const record = part as Record<string, unknown>;
          return record.type === "output_text" && typeof record.text === "string" ? [record.text] : [];
        }).join("");
      }
      continue;
    }
    if (item.type === "reasoning") {
      const parts = [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : [])
      ];
      reasoning += parts.flatMap((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return [];
        const record = part as Record<string, unknown>;
        return (record.type === "summary_text" || record.type === "reasoning_text") && typeof record.text === "string"
          ? [record.text]
          : [];
      }).join("");
      continue;
    }
    if (item.type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "";
      const name = typeof item.name === "string" ? item.name : "";
      if (!callId || !name) continue;
      toolCalls.push({
        id: callId,
        type: "function",
        function: { name, arguments: serializedToolArguments(item.arguments) }
      });
    }
  }
  const status = typeof response.status === "string" ? response.status : "";
  const incompleteReason = response.incomplete_details && typeof response.incomplete_details === "object" && !Array.isArray(response.incomplete_details)
    ? (response.incomplete_details as Record<string, unknown>).reason
    : null;
  const finishReason = toolCalls.length > 0
    ? "tool_calls"
    : status === "incomplete"
      ? incompleteReason === "max_output_tokens" ? "length" : "incomplete"
      : status === "completed" ? "stop" : null;
  return {
    ...(response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
      ? { usage: response.usage as Record<string, unknown> }
      : {}),
    choices: [{
      finish_reason: finishReason,
      message: {
        content: text || null,
        reasoning_content: reasoning || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      }
    }]
  };
}

export function parseCompletionPayload(protocol: AiProviderProtocol, value: unknown): CompletionPayload {
  if (usesOpenAiResponsesShape(protocol)) return parseResponsesPayload(value);
  if (usesOpenAiChatCompletionsShape(protocol)) {
    return value && typeof value === "object" && !Array.isArray(value) ? value as CompletionPayload : {};
  }
  const response = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const content = Array.isArray(response.content) ? response.content : [];
  const replay = content.map(replayableAnthropicBlock).filter((block): block is AnthropicReplayContentBlock => block !== null);
  const text = content.flatMap((value) => {
    const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("");
  const reasoning = content.flatMap((value) => {
    const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (block.type === "thinking" && typeof block.thinking === "string") return [block.thinking];
    if (block.type === "text" && typeof block.thinking === "string") return [block.thinking];
    return [];
  }).join("");
  const toolCalls: CompletionToolCall[] = content.flatMap((value) => {
    const block = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") return [];
    return [{
      id: block.id,
      type: "function" as const,
      function: {
        name: block.name,
        arguments: parsedToolInput(block.input)
      }
    }];
  });
  return {
    ...(response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
      ? { usage: response.usage as Record<string, unknown> }
      : {}),
    choices: [{
      finish_reason: anthropicFinishReason(response.stop_reason),
      message: {
        content: text || null,
        reasoning_content: reasoning || null,
        tool_calls: toolCalls,
        anthropic_content: replay
      }
    }]
  };
}
