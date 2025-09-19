import type { RealtimeAgent } from "@openai/agents/realtime";
import { allAgentSets, defaultAgentSetKey } from "../../app/agentConfigs";

/**
 * Utilities for resolving which agent/scenario to use for a Twilio-originated call.
 * Parameters can come from the initial query string (e.g., on the WS upgrade) or
 * the Twilio Media Stream `customParameters` payload.
 */
export const AGENT_PARAM_KEYS = ["agent", "agentKey", "agentName"] as const;
export type AgentParamKey = (typeof AGENT_PARAM_KEYS)[number];

export const SCENARIO_PARAM_KEYS = ["scenario", "scenarioKey"] as const;
export type ScenarioParamKey = (typeof SCENARIO_PARAM_KEYS)[number];

type ResolutionSource = "customParameters" | "query" | "defaults" | "argument";

type SourceName = "customParameters" | "query";

type SourceEntry = {
  name: SourceName;
  data: Record<string, string>;
};

const SOURCE_ORDER: ReadonlyArray<SourceName> = ["customParameters", "query"] as const;

export type AgentSelection = {
  /** Scenario key that ultimately won after resolution + validation. */
  scenarioKey: string;
  /** Alias for scenarioKey to keep compatibility with existing code paths. */
  scenario: string;
  /** All agents configured for the selected scenario. */
  agents: RealtimeAgent[];
  /** Name of the agent selected (if any) after resolution. */
  agentName: string | null;
  /** Concrete agent instance selected from the scenario (if found). */
  agent: RealtimeAgent | null;
  /**
   * Any extra parameters that were present once the known selection keys are removed.
   * Can be forwarded downstream for custom handling.
   */
  extras: Record<string, string>;
  resolvedFrom: Partial<Record<"scenarioKey" | "agentName", ResolutionSource>>;
};

export type ResolveAgentSelectionArgs = {
  query?: Record<string, string | string[] | undefined>;
  customParameters?: Record<string, string | undefined>;
  /** Preferred scenario key supplied programmatically. */
  scenario?: string | null;
  scenarioKey?: string | null;
  /** Preferred agent name supplied programmatically. */
  agent?: string | null;
  agentName?: string | null;
  defaults?: {
    scenario?: string | null;
    scenarioKey?: string | null;
    agent?: string | null;
    agentName?: string | null;
  };
};

const SELECTION_KEYS = new Set<string>([...AGENT_PARAM_KEYS, ...SCENARIO_PARAM_KEYS]);

function normalizeRecord(input?: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input) return result;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) result[key] = trimmed;
    } else if (Array.isArray(value)) {
      for (const candidate of value) {
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (trimmed) {
          result[key] = trimmed;
          break;
        }
      }
    }
  }
  return result;
}

function pickFromSources(keys: readonly string[], sources: SourceEntry[]): { value?: string; source?: SourceEntry["name"] } {
  for (const src of sources) {
    for (const key of keys) {
      const v = src.data[key];
      if (typeof v === "string" && v.length > 0) {
        return { value: v, source: src.name };
      }
    }
  }
  return {};
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function ensureScenarioKey(rawKey: string | null): string {
  if (rawKey && allAgentSets[rawKey]) {
    return rawKey;
  }
  return defaultAgentSetKey;
}

export function resolveAgentSelection(args: ResolveAgentSelectionArgs = {}): AgentSelection {
  const { query, customParameters, defaults } = args;

  const normalizedQuery = normalizeRecord(query);
  const normalizedCustom = normalizeRecord(customParameters);

  const sources: SourceEntry[] = SOURCE_ORDER.map((name) => ({
    name,
    data: name === "customParameters" ? normalizedCustom : normalizedQuery,
  }));

  const scenarioPick = pickFromSources(SCENARIO_PARAM_KEYS, sources);
  const agentPick = pickFromSources(AGENT_PARAM_KEYS, sources);

  const resolvedFrom: AgentSelection["resolvedFrom"] = {};

  let scenarioKey = scenarioPick.value ?? null;
  let scenarioSource: ResolutionSource | undefined = scenarioPick.source;
  if (!scenarioKey) {
    const argScenarioKey = firstNonEmpty(args.scenarioKey, args.scenario);
    if (argScenarioKey) {
      scenarioKey = argScenarioKey;
      scenarioSource = "argument";
    }
  }
  if (!scenarioKey) {
    const defaultScenarioKey = firstNonEmpty(defaults?.scenarioKey, defaults?.scenario);
    if (defaultScenarioKey) {
      scenarioKey = defaultScenarioKey;
      scenarioSource = "defaults";
    }
  }
  scenarioKey = ensureScenarioKey(scenarioKey);
  if (!scenarioSource) {
    scenarioSource = scenarioPick.source ?? "defaults";
  }
  resolvedFrom.scenarioKey = scenarioSource;

  let agentName = agentPick.value ?? null;
  let agentSource: ResolutionSource | undefined = agentPick.source;
  if (!agentName) {
    const argAgentName = firstNonEmpty(args.agentName, args.agent);
    if (argAgentName) {
      agentName = argAgentName;
      agentSource = "argument";
    }
  }
  if (!agentName) {
    const defaultAgentName = firstNonEmpty(defaults?.agentName, defaults?.agent);
    if (defaultAgentName) {
      agentName = defaultAgentName;
      agentSource = "defaults";
    }
  }
  if (agentSource) {
    resolvedFrom.agentName = agentSource;
  }

  const agentsForScenario = allAgentSets[scenarioKey] ?? [];
  const selectedAgent = agentName ? agentsForScenario.find((agent) => agent.name === agentName) ?? null : null;

  const extras: Record<string, string> = { ...normalizedQuery, ...normalizedCustom };
  for (const key of SELECTION_KEYS) {
    if (key in extras) {
      delete extras[key];
    }
  }

  return {
    scenarioKey,
    scenario: scenarioKey,
    agents: agentsForScenario,
    agentName,
    agent: selectedAgent,
    extras,
    resolvedFrom,
  };
}
