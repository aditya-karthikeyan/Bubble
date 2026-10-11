# Demo runbook: messaging (P2)

Everything people see in iMessage. Pairs with P1's `pnpm demo:reset` (clears plans, keeps
people and crews) and P3's `docs/demo-p3.md`.

## Before the demo (once)

1. Every teammate has texted their own bubble at least once (Photon Pro only lets the bubble
   text people who texted first). Bubble numbers: `pnpm p2:demo status`.
2. Build the demo crew from the team's handles (phones, or the Apple ID email for anyone whose
   iMessage runs on email):

   ```
   DATABASE_PATH=./data/demo.db pnpm p2:demo crew +19806220567 +17044509973 +19806802089
   ```

3. Set `WEB_PUBLIC_URL` to the deployed live page so the bundle includes the preview card.

## Judges (about a minute each)

```
DATABASE_PATH=./data/demo.db pnpm p2:demo add-judge "Ada Lovelace" +15551234567
```

Prints a QR code (and saves `judge-<digits>.png`). The judge scans it, Messages opens to their
own bubble with "hi" typed, they tap send. `pnpm p2:demo status` shows them as ready once that
text lands. If their iMessage uses an email, add `--imessage-email them@icloud.com`.

## Run

1. Post LINE LOCK (only one process may read the Photon message stream).
2. `DATABASE_PATH=./data/demo.db pnpm p2:demo serve` (real server, real line, DEMO_MODE: 60 s
   deadlines, 15 s veto window).
3. Organizer texts their bubble: `dinner tonight?`
4. Everyone: tap 👍 on the headcount line within 60 s, vote if a poll appears.
5. Watch the headcount line edit itself: finding the spot -> 🔒 locked -> 📞 calling -> ✅ booked,
   then the ticket image.
6. Between runs: `DATABASE_PATH=./data/demo.db pnpm demo:reset`.

Measured on 3 real phones (2026-10-10): typing 1 ms, poll on every phone 3.0 s, booked 62 s.

## Lines worth showing

- `why this place?` -> group-level explanation
- `wait` / `resume` -> pause and resume
- `what's Soham's budget?` -> "I keep everyone's details private 🫧 ..."

## If something goes wrong

| Symptom                               | Fix                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Someone gets nothing                  | They have not texted their bubble yet: have them send "hi"                                    |
| "Target not allowed" in logs          | That handle is not registered: `p2:demo add-judge`                                            |
| Replies twice                         | Two processes on the line: stop all but one                                                   |
| iMessage delivery slow on venue Wi-Fi | Play P4's recorded clean run; keep `pnpm p2:redteam` and `pnpm sim basic` as terminal backups |
