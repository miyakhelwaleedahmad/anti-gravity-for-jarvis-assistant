# Remote access: threat model and requirements (OPS-02)

**Status: not available.** Every JARVIS listener binds loopback only (`127.0.0.1`, `::1` or `localhost`) through one rule, `assertLoopbackBind()` in `security/remoteAccess.ts`. Nothing in this branch exposes JARVIS to the network, and nothing was deployed. This page covers what must exist before that changes.

## What listens today

| Listener | File | Bind | Access check |
|---|---|---|---|
| Voice bridge (WebSocket) and `/health` | `bridge/nodeBridge.ts` | `BRIDGE_HOST`, refused unless loopback | Token, Origin refused (SEC-01) |
| Vector memory service | `memory/vectorMemory.py` | `127.0.0.1:8000` | Token on every route but `/liveness` (SEC-18) |
| A2A endpoint (only with `JARVIS_A2A_PORT`) | `core/agents/a2a.ts` | `127.0.0.1` | Bearer token, Host check, browser Origin refused |
| Control Center (only with `JARVIS_CONTROL_CENTER=1`) | `system/controlCenter.ts` | `127.0.0.1` | Login token, session cookie, CSRF, Host and Origin checks (OPS-01) |

`tests/remoteAccessTest.ts` fails if any `listen()` call omits a host, if any source binds `0.0.0.0`, or if one of these listeners stops using the shared rule.

## Threats a remote listener would add

| Threat | Why it matters here |
|---|---|
| Someone on the same network reaches JARVIS | JARVIS controls the PC: files, apps, keyboard, browser |
| A stolen or lost phone | A paired device could keep its access |
| Replayed requests | A captured "pause goal" or tool call is sent again |
| Remote approval | Approving from afar removes the person at the PC from level 3–4 actions |
| Traffic read on the way | Replies can contain file contents, page text and memory |
| A web page using the owner's logged-in browser | Cross-site requests to a remote endpoint (as SEC-01 and SEC-18 were for local ones) |
| Secrets in replies | API keys or tokens shown on another device |

## Requirements before any remote listener

1. **Transport:** TLS only, with a certificate the device pins. No plain HTTP or WebSocket off the PC.
2. **Per-device identity:** each device is paired at the PC (shown on screen, confirmed by typing) and holds its own key. JARVIS records the key's fingerprint, never a shared password.
3. **Request signing:** every request is signed by the device key, carries its time (accepted within 60 s) and a nonce that is accepted once.
4. **Revocation:** a device can be revoked at the PC; a revoked device is refused from the next request on. The list of devices and revocations is stored next to the permission session, owner-only.
5. **What a device may do:** a list of tools per device, and a risk cap of at most level 1 (`REMOTE_MAX_RISK`), applied after the risk engine has assessed the call. The registry, risk engine and approval gate still run.
6. **Never remote:** approving an action, changing permissions or full control, pairing or revoking devices, changing this policy. These stay at the PC (console or voice).
7. **Secrets:** replies pass the redactor, as the Control Center's do. Tokens and keys never leave the PC.
8. **Audit:** every remote request is recorded with its device, decision and reason, in the existing security audit log.
9. **Rate limits:** per device, on top of the tool rate limits.
10. **Bind:** a remote listener would bind one chosen interface address, never `0.0.0.0`, and only when the owner turns it on.

`decideRemoteRequest()` in `security/remoteAccess.ts` encodes items 3–6 in the order a listener must apply them. With remote access off, which is the only state today, it refuses everything. The test turns it on in-process to check each refusal:
- no TLS;
- an unknown or revoked device;
- a wrong key or signature;
- an old or replayed request;
- approval;
- admin changes;
- a tool above level 1 or off the device's list.

## Not done

Implementation is limited to the decision function and the bind rule; neither is connected to any network path. There is no pairing, signing, TLS listener, device store or remote audit record. Turning remote access on needs all of the above. It also needs testing on the owner's network.
