# Evidence

`temporal-web-ui.png` shows one representative Workflow in the Temporal Web UI:
`opening-2026-10-07-1400-ana-haircut-17d2`, status **Completed**, with the event
history in compact view, oldest first:

1. `findMatchingClients`: three clients fit, in waitlist order
2. `sendText`: offer to Maya
3. Timer: her 15-minute hold (15 seconds on the demo clock) runs out
4. `sendText`: offer to Jordan, with a new timer
5. Update `clientReply` → `too_late`: Maya's late yes, then a polite text back
6. Update `clientReply` → `accepted`: Jordan's yes
7. `markBooked`, `sendText` (confirmation), `notifyFrontDesk` ("Please add it to Square")

All names and numbers are made-up sample data.
