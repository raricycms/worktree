![icon](./worktree-icon.png)
# WORKTREE
## Efficiently manage your work!

Conviently organize your work on a worktree.
Every workstep relies on other steps, you can complete them until every relied step is completed.
**Add**, **Switch**, and **Complete**!

## Scheduling assistant

The web app has an AI assistant that talks to your own OpenAI-compatible model
endpoint from the browser, so your API key never reaches the worktree server.
One chat does the whole job: describe an event or task, ask what is planned,
paste a chat screenshot to turn it into todos, or attach a timetable photo and
confirm the parsed classes in an editable preview. When something is genuinely
ambiguous the assistant asks instead of guessing, and every change still goes
through the normal history, undo and sync path. Replies stream, conversations
are kept locally in the browser, and destructive changes are confirmed.

Configure it under Settings → AI assistant (the semester fields are used for
week-based timetables), then open the Agent tab. See
[docs/agent.md](docs/agent.md) for the architecture, the tool contract, the
prompt's playbooks and the test setup.