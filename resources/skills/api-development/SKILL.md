# API Development

Add or change an endpoint in the style of the existing API.

1. Read the current routes, input validation, and auth checks with read_file and search_codebase.
2. Edit with edit_file. Validate inputs, return the project's error shape, and keep the existing auth boundary.
3. Cover the behavior with the project's current test style and run run_tests, filtered to that endpoint when the runner supports a filter.
4. Report the status and error behavior the test returned. Do not invent a response.
