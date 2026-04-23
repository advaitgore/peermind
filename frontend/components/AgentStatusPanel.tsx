"use client";

import { useJob, type AgentState, type AgentStatus } from "@/lib/store";
import type { AgentId } from "@/lib/store";

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "idle",
  running: "streaming",
  done: "done",
  error: "error",
};

function AgentRow({ agent, idx }: { agent: AgentState; idx: number }) {
  return (
    <div
      className="agent-row flex items-center gap-3 py-2 px-1"
      style={{ animationDelay: `${idx * 60}ms` }}
    >
      <span className="agent-dot" data-status={agent.status} aria-hidden />
      <span
        className="flex-1 text-[var(--text-sm)]"
        style={{
          color:
            agent.status === "idle"
              ? "var(--color-text-faint)"
              : "var(--color-text)",
        }}
      >
        {agent.label}
      </span>
      <span
        className="eyebrow"
        style={{
          color:
            agent.status === "running"
              ? "var(--color-primary-strong)"
              : agent.status === "done"
              ? "var(--color-text-muted)"
              : "var(--color-text-faint)",
        }}
      >
        {STATUS_LABEL[agent.status]}
      </span>
    </div>
  );
}

export function AgentStatusPanel() {
  const agents = useJob((s) => s.agents);
  const currentRound = useJob((s) => s.currentRound) || 1;
  const maxRounds = useJob((s) => s.maxRounds);
  const complete = useJob((s) => s.complete);

  const list: Array<{ id: AgentId; agent: AgentState }> = [
    { id: "orchestrator", agent: agents.orchestrator },
    { id: "reviewer1", agent: agents.reviewer1 },
    { id: "reviewer2", agent: agents.reviewer2 },
    { id: "scout", agent: agents.scout },
    { id: "code_runner", agent: agents.code_runner },
    { id: "fix_agent", agent: agents.fix_agent },
  ];
  const total = list.length;
  const done = list.filter((a) => a.agent.status === "done").length;
  const running = list.filter((a) => a.agent.status === "running").length;

  const pips = Array.from({ length: maxRounds }, (_, i) => i + 1);

  return (
    <div className="flex flex-col h-full">
      {/* Round progress header */}
      <div className="px-[var(--space-4)] py-[var(--space-4)] border-b border-[color:var(--color-border)]">
        <div className="flex items-baseline justify-between mb-2">
          <span className="eyebrow">
            Round {Math.min(currentRound, maxRounds)}/{maxRounds}
          </span>
          {complete && (
            <span
              className="eyebrow"
              style={{ color: "var(--color-champion)" }}
            >
              complete
            </span>
          )}
        </div>
        <div className="flex gap-1.5 mb-3">
          {pips.map((n) => {
            const state =
              n < currentRound || (complete && n === currentRound)
                ? "done"
                : n === currentRound
                ? "active"
                : "pending";
            return <span key={n} className="round-pip" data-state={state} />;
          })}
        </div>
        <div
          className="text-[var(--text-xs)] font-mono"
          style={{ color: "var(--color-text-muted)" }}
        >
          {total} managed agents · {running > 0 ? `${running} live` : `${done}/${total} done`}
        </div>
      </div>

      {/* Agent list */}
      <div className="px-[var(--space-3)] py-[var(--space-2)]">
        <div className="eyebrow px-1 pt-1 pb-2">Agents</div>
        {list.map(({ id, agent }, i) => (
          <AgentRow key={id} agent={agent} idx={i} />
        ))}
      </div>
    </div>
  );
}
