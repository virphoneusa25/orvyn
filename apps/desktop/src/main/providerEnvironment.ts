/** Only the backend child receives inference credentials. Renderer and worker
 * children inherit a scrubbed environment; nothing is written to disk or IPC. */
export function captureProviderCredentials(env: Record<string, string | undefined>): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const name of ["HUGGINGFACE_API_KEY", "HF_TOKEN", "NEBIUS_API_KEY", "FIREWORKS_API_KEY", "MODEL_API_KEY", "OPENAI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    if (env[name]) captured[name] = env[name]!;
    delete env[name];
  }
  return captured;
}
