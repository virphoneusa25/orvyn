# Web Research

Search the web widely enough to answer the question and keep every source attached to its claim.

1. Never fabricate sources, citations, quotations, facts, or evidence. Label each claim as a sourced fact, a model inference, a hypothesis, or a recommendation. When sources disagree, show the disagreement and the limitation instead of silently picking one. Summarize or extract a large input before sending unnecessary raw content to an expensive model. Do not use write_file, edit_file, terminal, or ssh_exec unless the user explicitly asks for implementation.
2. Call web_search broadly enough to answer the question. Prefer current and authoritative sources. Open the pages that matter with fetch_url, and use browser_open only in the existing browser session when the fetched text is not enough.
3. Preserve source attribution: name the page and URL the tool returned. A sourced fact is only what that result said. Anything beyond it is a model inference, a hypothesis, or a recommendation.
