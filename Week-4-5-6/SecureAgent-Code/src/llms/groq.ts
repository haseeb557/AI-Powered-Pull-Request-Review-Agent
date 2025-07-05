import { Groq } from "groq-sdk";
import { env } from "../env";
import { ChatCompletionCreateParamsBase } from "groq-sdk/resources/chat/completions";

export const groq = new Groq({
  apiKey: env.GROQ_API_KEY,
});

export type GroqChatModel = "llama-3.3-70b-versatile" | "gemma-7b-it" | "llama3-70b-8192" | "llama3-8b-8192" | ChatCompletionCreateParamsBase["model"];

export const GROQ_MODEL: GroqChatModel = "llama-3.3-70b-versatile";
