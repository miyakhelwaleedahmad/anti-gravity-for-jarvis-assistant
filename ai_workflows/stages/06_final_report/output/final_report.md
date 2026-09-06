# Final Report — [Replace with Bug Name]

> Stage: 06_final_report
> Status: [ ] Complete
> Date: [fill in]

---

## 1. Root Cause

[Exact description of what was broken and why]

---

## 2. Files Changed

| File | What Changed | Protected File? |
|---|---|---|
| [path/to/file.ts] | [description] | Yes/No |

---

## 3. Test Results Summary

| Test | Status |
|---|---|
| `npx tsc --noEmit` | ✅/❌ |
| `nodeBridgeSingletonTest.ts` | ✅/❌ |
| `voiceRouteMockTest.ts` | ✅/❌ |
| `interruptGatingTest.ts` | ✅/❌ |
| `openAppSmokeTest.ts youtube` | ✅/❌ |
| `deterministicCommandRouteTest.ts` | ✅/❌ |
| Live voice test | ✅/❌/N/A |

---

## 4. Unresolved Risks

| Risk | Severity | Recommended Action |
|---|---|---|
| [risk] | High/Medium/Low | [action] |

---

## 5. Next Recommended Step

[What should be done next — specific and actionable]

---

## 6. Verdict

- [ ] ✅ Bug confirmed fixed — live voice verified, all tests pass
- [ ] ⚠️ Bug partially fixed — remaining issues listed above
- [ ] ❌ Bug not fixed — see unresolved risks

---

## 7. Post-Report Checklist

- [ ] `_config/JARVIS_CURRENT_STATUS.md` updated
- [ ] `ai_workflows/CONTEXT.md` updated if system status changed
- [ ] Git commit created: `git commit -m "Fix [bug]: [description]"`
- [ ] Stable tag created (with user approval): `git tag stable-[feature]-v[N]`
