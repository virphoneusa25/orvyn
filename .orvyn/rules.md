# ORVYN Project Rules

These instructions are automatically included in AI requests for this project.

- Always use TypeScript.
- Do not use `any` without justification.
- Use async/await, not raw Promise chains.
- Keep model adapters vendor-neutral — no direct OpenAI/Anthropic SDK calls in ai-core.
