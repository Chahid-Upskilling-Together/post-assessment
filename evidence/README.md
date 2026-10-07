# Evidence

`temporal-web-ui.png` shows one representative Workflow in the Temporal Web UI:
`opening-2026-10-07-1400-ana` (Ana's 2:00 pm slot), status **Completed**, with
the event history in compact view, oldest first:

1. `findMatchingClients`: three clients fit, in waitlist order
2. `startOffer` → `"ok"`: Maya is still eligible and not holding another offer
3. `sendText`: offer to Maya
4. Timer, 30 seconds: her 15-minute hold on the demo clock runs out
5. `endOffer`, `startOffer` → `"ok"`, `sendText`: offer to Jordan, with a new timer
6. Update `clientReply` → `too_late`: Maya's late yes, then a polite text back
7. Update `clientReply` → `accepted`: Jordan's yes
8. `markBooked`, `endOffer`, `sendText` (confirmation), `notifyFrontDesk` ("Please add it to Square")

All names and numbers are made-up sample data.
