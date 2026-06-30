import { GoogleGenAI } from "@google/genai";
import {
  correctionPrompt,
  geminiPrompt,
  geminiSchema,
  normalizeSelection,
  sourceIdentifiers,
  validatePublicSelection
} from "./hot-story-content.mjs";

const PROVIDERS = new Set(["vertex", "gemini"]);

export function resolveAiConfig(env = process.env) {
  const provider = String(env.HOT_STORY_AI_PROVIDER || "vertex").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error(`HOT_STORY_AI_PROVIDER must be "vertex" or "gemini", received: ${provider || "(empty)"}`);
  }

  if (provider === "gemini") {
    const apiKey = String(env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required when HOT_STORY_AI_PROVIDER=gemini.");
    }
    return {
      provider,
      model: String(env.GEMINI_MODEL || "gemini-2.5-flash").trim(),
      apiKey
    };
  }

  const project = String(env.VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || "").trim();
  if (!project) {
    throw new Error("VERTEX_PROJECT_ID is required when HOT_STORY_AI_PROVIDER=vertex.");
  }
  return {
    provider,
    model: String(env.VERTEX_MODEL || "gemini-2.5-flash").trim(),
    project,
    location: String(env.VERTEX_LOCATION || env.GOOGLE_CLOUD_LOCATION || "us-central1").trim()
  };
}

export function createAiClient(config, ClientClass = GoogleGenAI) {
  if (config.provider === "gemini") {
    return new ClientClass({ apiKey: config.apiKey });
  }
  return new ClientClass({
    vertexai: true,
    project: config.project,
    location: config.location,
    apiVersion: "v1"
  });
}

function extractResponseJson(response) {
  const text = typeof response?.text === "string"
    ? response.text
    : response?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  const clean = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  if (!clean) throw new Error("AI provider returned an empty response.");
  return JSON.parse(clean);
}

export async function selectWithAi(items, sources, options = {}) {
  const config = options.config || resolveAiConfig(options.env || process.env);
  const client = options.client || createAiClient(config);
  const identifiers = sourceIdentifiers(items, sources);
  let prompt = geminiPrompt(items, identifiers);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await client.models.generateContent({
        model: config.model,
        contents: prompt,
        config: {
          temperature: attempt === 1 ? 0.35 : 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: geminiSchema()
        }
      });
      const selection = normalizeSelection(extractResponseJson(response));
      const violations = validatePublicSelection(selection, items, identifiers);
      if (violations.length) {
        if (attempt === 2) throw new Error(`public-content validation failed: ${violations.join("; ")}`);
        console.warn(`[${config.provider}] Noi dung chua dat, yeu cau sua: ${violations.join("; ")}`);
        prompt = correctionPrompt(selection, violations);
        continue;
      }
      return {
        ...selection,
        provider: config.provider,
        model: config.model,
        rawResponse: response
      };
    } catch (error) {
      if (attempt === 2) {
        const authHint = config.provider === "vertex"
          ? " Verify Vertex ADC, project, location, IAM role roles/aiplatform.user, and Vertex AI API availability."
          : " Verify GEMINI_API_KEY and Gemini API access.";
        throw new Error(`${config.provider} hot-story generation failed closed: ${error.message}.${authHint}`);
      }
      console.warn(`[${config.provider}] Thu lai lan ${attempt + 1}: ${error.message}`);
    }
  }
  throw new Error(`${config.provider} hot-story generation failed closed after retry.`);
}
