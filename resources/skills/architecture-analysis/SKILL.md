# Architecture Analysis

Describe how the system is actually put together, including the boundaries and tradeoffs the code shows.

1. Never fabricate sources, citations, quotations, facts, or evidence. Label each claim as a sourced fact, a model inference, a hypothesis, or a recommendation. When sources disagree, show the disagreement and the limitation instead of silently picking one. Summarize or extract a large input before sending unnecessary raw content to an expensive model. Do not use write_file, edit_file, terminal, or ssh_exec unless the user explicitly asks for implementation.
2. Use get_project_outline, search_codebase, and read_file. Describe components, dependencies, data flow, failure boundaries, security boundaries, and tradeoffs that those results show.
3. Do not recommend a rewrite without evidence. A missing diagram is not evidence that the design should be replaced.
