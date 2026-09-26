# Long Document Analysis

Read the surrounding section of a long document before drawing a conclusion.

1. Never fabricate sources, citations, quotations, facts, or evidence. Label each claim as a sourced fact, a model inference, a hypothesis, or a recommendation. When sources disagree, show the disagreement and the limitation instead of silently picking one. Summarize or extract a large input before sending unnecessary raw content to an expensive model. Do not use write_file, edit_file, terminal, or ssh_exec unless the user explicitly asks for implementation.
2. Inspect the relevant full section and its surrounding context with read_document or read_file. Do not draw a conclusion from an isolated snippet or from disconnected snippets.
3. Preserve the section, page, or source reference the tool result gave. If that reference is missing, say so instead of inventing a page number.
