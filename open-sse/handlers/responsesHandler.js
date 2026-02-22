/**
 * Responses API Handler for Workers
 * Converts Chat Completions to Codex Responses API format
 */

import { handleChatCore } from "./chatCore.js";
import { convertResponsesStreamToJson } from "../transformer/streamToJsonConverter.js";

function convertChatCompletionToResponsesJson(chat) {
  if (!chat || typeof chat !== "object") return chat;
  if (chat.object === "response") return chat;
  if (!Array.isArray(chat.choices)) return chat;

  const choice = chat.choices[0] || {};
  const message = choice.message || {};
  const output = [];
  const createdAt = Number(chat.created) || Math.floor(Date.now() / 1000);
  const responseId = chat.id ? "resp_" + chat.id : "resp_" + Date.now();

  if (message.reasoning_content) {
    output.push({
      id: "rs_" + responseId + "_0",
      type: "reasoning",
      summary: [{ type: "summary_text", text: String(message.reasoning_content) }]
    });
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        id: tc.id ? "fc_" + tc.id : "fc_" + Date.now(),
        type: "function_call",
        arguments: tc.function?.arguments || "{}",
        call_id: tc.id || "",
        name: tc.function?.name || ""
      });
    }
  }

  const text = typeof message.content === "string"
    ? message.content
    : (Array.isArray(message.content) ? message.content.map((p) => p?.text || "").join("") : "");
  if (text && text.length > 0) {
    output.push({
      id: "msg_" + responseId + "_0",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], logprobs: [], text }]
    });
  }

  const usage = chat.usage || {};
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
    },
    model: chat.model
  };
}

/**
 * Handle /v1/responses request
 * @param {object} options
 * @param {object} options.body - Request body (Responses API format)
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} options.log - Logger instance (optional)
 * @param {function} options.onCredentialsRefreshed - Callback when credentials are refreshed
 * @param {function} options.onRequestSuccess - Callback when request succeeds
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @returns {Promise<{success: boolean, response?: Response, status?: number, error?: string}>}
 */
export async function handleResponsesCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  onDisconnect,
  connectionId,
  clientRawRequest,
  userAgent,
  apiKey
}) {
  // Preserve client's stream preference (matches OpenClaw behavior)
  // Default to false if omitted: Boolean(undefined) = false
  const clientRequestedStreaming = body.stream === true;
  const requestBody = body.stream === undefined ? { ...body, stream: false } : body;

  // Call chat core handler
  const result = await handleChatCore({
    body: requestBody,
    modelInfo,
    credentials,
    log,
    onCredentialsRefreshed,
    onRequestSuccess,
    onDisconnect,
    connectionId,
    clientRawRequest,
    userAgent,
    apiKey
  });

  if (!result.success || !result.response) {
    return result;
  }

  const response = result.response;
  const contentType = response.headers.get("Content-Type") || "";
  const isSSE =
    contentType.includes("text/event-stream") ||
    (contentType === "" && modelInfo?.provider === "codex");

  // Case 1: Client wants non-streaming, but got SSE (provider forced it, e.g., Codex)
  if (!clientRequestedStreaming && isSSE) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(response.body);

      return {
        success: true,
        response: new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
          }
        })
      };
    } catch (error) {
      console.error("[Responses API] Stream-to-JSON conversion failed:", error);
      return {
        success: false,
        status: 500,
        error: "Failed to convert streaming response to JSON"
      };
    }
  }

  // Case 2: Client wants streaming, got SSE.
  // chatCore already emits client-target format for Responses requests.
  if (clientRequestedStreaming && isSSE) {
    return {
      success: true,
      response,
    };
  }

  // Case 3: Non-SSE response. Keep Responses schema for non-stream clients.
  if (!clientRequestedStreaming) {
    try {
      const body = await response.clone().json();
      const converted = convertChatCompletionToResponsesJson(body);
      if (converted !== body) {
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        return {
          success: true,
          response: new Response(JSON.stringify(converted), {
            status: response.status,
            headers
          })
        };
      }
    } catch {
      // Non-JSON or unreadable payload: fall through and return as-is.
    }
  }

  // Default: return original response unchanged.
  return result;
}
