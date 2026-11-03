# Skill: device-automation

| Field   | Value                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| id      | `device-automation`                                                                                                      |
| version | 0.0.1 (draft)                                                                                                            |
| status  | Planned — Phase 3 (iOS App Intents / Shortcuts), Phase 6 (Android, macOS)                                                |
| tools   | planned: `device.run_shortcut`, `device.set_reminder`, `device.open_url` (executed on the user's device, not the server) |

## Description

Lets JARVIS trigger actions on the user's own device — run a named Shortcut, create a Reminder, open
an app or link — and lets Siri/Shortcuts send requests to JARVIS.

## Input / output sketch

```ts
runShortcut: { deviceId: string; shortcutName: string /* from an allow-list the user configures */;
               input?: string }
→ { deviceId, status: 'ran' | 'not_found' | 'denied'; output?: string }
```

Delivery: server → push notification → app executes after local confirmation → result posted back.

## Permissions and risk

- Device must be registered (`devices`) and the shortcut explicitly allow-listed by the user on that
  device.
- Risk: `MEDIUM` (runs code on the device); shortcuts that send messages or spend money are the user's
  responsibility to exclude; JARVIS treats unknown shortcuts as `HIGH`.

## Cost limits

No model cost beyond planning.

## Execution policy

- On-device confirmation (biometric or tap) before running, independent of server approval.
- Incoming App Intents only create tasks; they can never approve an action by themselves.

## Verification criteria

Result posted by the device within a timeout, signed by the device session; otherwise
`OUTCOME_UNKNOWN`.

## Error handling

Device offline → expires after the approval TTL; shortcut missing → `not_found`; user declines on
device → `CANCELLED`.

## Test cases

1. "Hey Siri, ask JARVIS to summarise <link>" → task created with `source: voice`, normal flow.
2. Shortcut not allow-listed → denied.
3. Device offline → task expires with a clear message.
