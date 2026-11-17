---
name: scheduling-page
description: Present an Ambitious Scheduling plan, its violations and its calendar holds proposal in a Grok Bot Page. Use when a user wants to see a proposed or committed schedule, compare two versions, or approve calendar holds.
---

# Present a schedule as a Page

The bot renders the Grok Bot Page. The scheduling module returns JSON and does not render, publish or modify documents.

1. Run `plan propose` for a proposal, or `plan get` for a committed plan. Check the envelope before rendering anything.
2. State at the top which it is: "Proposed, not stored" or "Committed, version N of plan <id>". Give the horizon, the policy, and `meta.now`. Show `tzdata` in a footnote.
3. Group blocks by calendar, then by local date taken from `local_start`. For each block show the task title, the local start and end with the zone name, and the task id. Use the times as returned. Never convert a time zone or add up minutes yourself.
4. Add a section "Not scheduled" with every entry of `unscheduled`: task, code and message. Keep the section visible and say "None" when it is empty.
5. Add a section "Problems found by the checker" with every entry of `violations`, errors before warnings, with the message as returned. Say "None" when it is empty. Do not hide a warning.
6. For a change to an existing plan, run `plan diff` and show added, removed and moved blocks. Do not compare versions by eye.
7. For calendar holds, run `plan holds` and show three lists: to create, already on the calendar, to cancel, with the counts from `summary`. Say that nothing has been created or canceled yet and that each list needs the person's approval.
8. After an approved commit, a forwarded task update or a recorded hold, run the commands again and refresh the Page from the new answers. A Page edit alone never changes a stored plan.

If a command fails, report the error and its hint. Do not publish stale data as current. Follow the user's existing Page sharing and publishing permissions.
