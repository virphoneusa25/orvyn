# Root Cause Analysis

Follow the evidence from the symptom to a cause, and stop when the chain is incomplete.

1. Never fabricate sources, citations, quotations, facts, or evidence. Label each claim as a sourced fact, a model inference, a hypothesis, or a recommendation. When sources disagree, show the disagreement and the limitation instead of silently picking one. Summarize or extract a large input before sending unnecessary raw content to an expensive model. Do not use write_file, edit_file, terminal, or ssh_exec unless the user explicitly asks for implementation.
2. Build the evidence chain from read_file, search_codebase, and read_process_logs when logs exist. Distinguish the symptom from the root cause, and list contributing factors separately.
3. Do not claim a root cause when the evidence is incomplete. Say what is still unknown.
