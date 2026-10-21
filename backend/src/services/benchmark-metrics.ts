/**
 * Accuracy of a benchmark run per skill, language, and check, each with a 95% Wilson interval: with a few dozen cases
 * per skill one case moves the share by several points, and the interval shows how much of a difference is noise.
 */
export interface Share {
  passed: number;
  total: number;
  /** Lower and upper bounds of the 95% interval of the share. */
  low: number;
  high: number;
}

export interface RunMetrics {
  overall: Share;
  bySkill: Record<string, Share>;
  byLanguage: Record<string, Share>;
  /** How often the right tool was chosen, and how often its arguments were right when it was. */
  tool: Share;
  args: Share;
}

export function wilson(passed: number, total: number): Share {
  if (!total) return { passed, total, low: 0, high: 0 };
  const z = 1.96;
  const share = passed / total;
  const denominator = 1 + (z * z) / total;
  const centre = (share + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((share * (1 - share)) / total + (z * z) / (4 * total * total))) / denominator;
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return { passed, total, low: round(centre - margin), high: round(centre + margin) };
}

export interface MetricInput {
  skill: string;
  language: string | null;
  passed: boolean;
  checks: Array<{ check: string; passed: boolean }>;
}

export function summarizeResults(results: MetricInput[]): RunMetrics {
  const group = (key: (result: MetricInput) => string | null) => {
    const counts = new Map<string, { passed: number; total: number }>();
    for (const result of results) {
      const name = key(result);
      if (!name) continue;
      const count = counts.get(name) ?? { passed: 0, total: 0 };
      count.total += 1;
      if (result.passed) count.passed += 1;
      counts.set(name, count);
    }
    return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => [name, wilson(count.passed, count.total)]));
  };
  const checkShare = (name: string) => {
    const checks = results.flatMap((result) => result.checks.filter((check) => check.check === name));
    return wilson(checks.filter((check) => check.passed).length, checks.length);
  };
  return {
    overall: wilson(results.filter((result) => result.passed).length, results.length),
    bySkill: group((result) => result.skill),
    byLanguage: group((result) => result.language),
    tool: checkShare("tool"),
    args: checkShare("args"),
  };
}
