# AgentPort adapters keep independent StageHandle implementations

`AgentPort` now has three implementations — `PiAgentAdapter`, `ClaudeAgentAdapter`,
and `FakeAgent` — each hand-rolling its own `StageHandle` wait/resume state
machine, with no shared base. This looks like an obvious unification target
once there are three of them, but we're not merging them: Pi's `StageHandle`
blocks in-process on a promise and resumes mid-thought by splicing an answer
into a pending tool call; Claude's never blocks at all and resumes via a
session-id replay after the tool call has already completed; the fake replays
from a scripted cursor file. A shared base would have to parameterize over
"does this ever block" and "how does resume replay state" — which is close to
reimplementing all three anyway. The seam that matters (`AgentPort`, at
`src/agent/port.ts`) already exists and is already shared; forcing a second,
implementation-level seam under it would be false economy, not depth.
