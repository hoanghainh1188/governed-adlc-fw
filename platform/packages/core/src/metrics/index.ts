// Process metrics (task E06, D-02 FR-12, design/ADR-M47).
export {
  GATE_METRICS_DEFAULT_DAYS,
  GATE_METRICS_MAX_ROWS,
  buildGateMetrics,
  checkGateMetricsRange,
  mergeGateMetrics,
  resolveGateMetricsRange,
  type GateMetrics,
  type GateMetricsInput,
  type GateMetricsRange,
  type GateMetricsRow,
  type GateMetricsScope,
  type WaitStats,
} from './gates.js';

// Agent efficiency report (task V13, design/ADR-M79).
export {
  AGENT_METRICS_MAX_ROWS,
  buildAgentMetrics,
  cacheShare,
  checkAgentMetricsRange,
  leadToEstimatePercent,
  mergeAgentMetrics,
  resolveAgentMetricsRange,
  type AgentMetrics,
  type AgentMetricsInput,
  type AgentMetricsRange,
  type AgentMetricsRow,
  type AgentMetricsScope,
} from './agents.js';
