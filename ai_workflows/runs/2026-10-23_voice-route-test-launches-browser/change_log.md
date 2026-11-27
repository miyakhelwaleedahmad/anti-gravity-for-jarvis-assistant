# Change Log — voiceRouteMockTest launches a real browser

> Stage: 04_implementation · Run: `ai_workflows/runs/2026-10-23_voice-route-test-launches-browser/`
> Status: [x] Complete
> Date: 2026-10-23 · Base commit: `0117a56` · Not committed (Stage 06 commits the reviewed files)

---

## Changed Files

| File | Change Description | Lines Affected |
|---|---|---|
| `tests/voiceRouteMockTest.ts` | Import `toolRegistryV2`; wrapper that makes `open_app` a dry run and records each call; wrapper restored; 2 new assertions | +1 at L22, +12 at L111–122, +9 at L174–182 (22 added, 0 removed) |
| `tests/boundary-doubles.json` | Entry for the new `registry:execute` stand-in | +6 at L189–194 |

---

## Change Details

### Red step (assertions without the fix)

Wrapper recorded `open_app` calls but passed the orchestrator's args unchanged.
Result: the new check failed, the stand-in opener recorded 2 launches.

```
  PASS    boundaryDoublesTest                          366ms
  FAIL    voiceRouteMockTest                           1799ms
        ✅ PASS: open_app ran for "youtube" once per request
        ❌ FAIL: open_app was a dry run (no browser launched)
      [open_app] platform=linux command=xdg-open args=https://www.youtube.com
      === Results: 10 passed, 1 failed ===
browser-opener calls: 2
```

### Green step (the approved fix)

```diff
-    const result = await originalExecute(name, args, signal);
+    const result = await originalExecute(name, { ...args, dryRun: true }, signal);
```

```
  PASS    boundaryDoublesTest                          343ms
  PASS    voiceRouteMockTest                           1262ms
=== 2 passed · 0 failed · 0 timed out · 0 blocked · 0 environment · 0 skipped ===
browser-opener calls: 0
```

### Final diff

```diff
+import { toolRegistryV2 } from '../core/toolRegistryV2.js';
 …
+  // open_app is a dry run: the route, risk engine and skill run for real, but
+  // the skill stops before launching the browser (this test used to open
+  // YouTube twice on every run).
+  const openAppResults: { target: unknown; success: boolean; output: string }[] = [];
+  const originalExecute = toolRegistryV2.execute.bind(toolRegistryV2);
+  (toolRegistryV2 as any).execute = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
+    if (name !== 'open_app') return originalExecute(name, args, signal);
+    const result = await originalExecute(name, { ...args, dryRun: true }, signal);
+    openAppResults.push({ target: args['target'], success: result.success, output: String(result.output) });
+    return result;
+  };
 …
+  (toolRegistryV2 as any).execute = originalExecute;
+  assert(
+    openAppResults.length === 2 && openAppResults.every((r) => r.target === 'youtube' && r.success),
+    'open_app ran for "youtube" once per request'
+  );
+  assert(
+    openAppResults.every((r) => /"dryRun":\s*true/.test(r.output)),
+    'open_app was a dry run (no browser launched)'
+  );
```

`tests/boundary-doubles.json`: entry `tests/voiceRouteMockTest.ts` →
`replaces: ["registry:execute"]`, with the reason text from the plan.

---

## TypeScript Compile Check

```
pnpm run typecheck        (runs tsc --noEmit)
Result: [x] 0 errors  [ ] Errors (list below)
```

---

## Unplanned Changes

- none. The code is the plan's text exactly. Run records in this folder
  (patch_plan approval, this file, verification.md) are workflow artifacts.

---

## Ready to Advance to Verification?

- [x] All approved changes applied
- [x] No unplanned changes made
- [x] pnpm run typecheck → 0 errors
- [x] Change log complete
