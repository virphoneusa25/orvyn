export interface RunEvaluation {
  score: number;
  completed: boolean;
  tests: "passed" | "failed" | "not_run";
  visual: boolean;
  artifacts: number;
  toolFailures: number;
  userRejected: boolean;
  eligibleForTraining: boolean;
  reasons: string[];
}

export function evaluateRun(input: {
  result: "success" | "failed" | "cancelled";
  testsRan: boolean;
  testsPassed?: boolean;
  visual: boolean;
  artifacts: number;
  failures: number;
  corrections: number;
}): RunEvaluation {
  const completed = input.result === "success";
  const tests = !input.testsRan ? "not_run" : input.testsPassed === false ? "failed" : "passed";
  const userRejected = input.corrections > 0 && input.result !== "success";
  const reasons: string[] = [];
  if (!completed) reasons.push("task not completed");
  if (tests === "failed") reasons.push("tests failed");
  if (input.failures > 0) reasons.push("unresolved tool failures");
  if (userRejected) reasons.push("user rejection");
  const score = Math.max(
    0,
    (completed ? 50 : 0) +
      (tests === "passed" ? 20 : 0) +
      (input.visual ? 10 : 0) +
      (input.artifacts > 0 ? 10 : 0) +
      (input.failures === 0 ? 10 : 0) -
      input.corrections * 5
  );
  return {
    score,
    completed,
    tests,
    visual: input.visual,
    artifacts: input.artifacts,
    toolFailures: input.failures,
    userRejected,
    eligibleForTraining: completed && tests !== "failed" && input.failures === 0 && !userRejected,
    reasons,
  };
}
