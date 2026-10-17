# Guide: schedule an agent

An agent with a `schedule` starts a turn on a timetable, with no one writing first.

```yaml
schedule:
  cron: "0 9 * * 1-5"
  timezone: Europe/London
  message: Post the morning summary.
```

| Field | Meaning |
|-------|---------|
| `cron` | A cron expression (validated on save) |
| `timezone` | IANA name; defaults to the Host's timezone |
| `message` | What the agent is asked each time. Default `Scheduled check-in.` |

## How it works

- While the Host runs, a tick (default every 30 s, `STAGEFLOW_AGENT_SCHEDULE_TICK_INTERVAL_MS`; `0` turns the scheduler off) starts a turn for every **enabled** agent whose next run is due.
- Each run is a **new session** with source `schedule`. Its limits (`max_turns`, `session_minutes`, `cost_usd`) apply as usual, and tools that ask first wait for a person like any other turn.
- The **first tick after you save or enable** a schedule only records the next run; it does not fire.
- If the Host was down past a due time, the agent fires **once** on the next tick, not once per missed occurrence.
- Editing a schedule to fire sooner takes effect on the next tick. A disabled agent never fires.
- The agent has no channel to reply on unless it also has `channel:`; scheduled results are found on the session page, or sent by a tool the agent is granted.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| Never fires | Agent disabled; scheduler off (`…TICK_INTERVAL_MS=0`); Host not running at the time (it catches up once) |
| Fires at the wrong hour | Missing or wrong `timezone` |
| `invalid schedule for agent` in the Host log | The cron expression does not parse for the timezone |
| Session `waiting` | A tool in `approvals.ask_first` needs a decision. Approve or deny it in the Inbox |
