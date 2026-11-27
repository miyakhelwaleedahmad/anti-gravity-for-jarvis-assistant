"""
tests/python/test_tts_pkg_resources_warning.py
─────────────────────────────────────────────────────────────────────────────
BUG-23: every start printed pygame's "pkg_resources is deprecated as an API"
warning. tts.py filtered DeprecationWarning and module="pkg_resources", but
newer setuptools raises it as a UserWarning attributed to the importer
(pygame.pkgdata, stacklevel=2), which neither filter matches.

Other warnings are still shown.
"""
import os
import sys
import types
import warnings

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "voice"))
sys.modules.setdefault("websockets", types.ModuleType("websockets"))

import tts  # noqa: E402,F401

passed = failed = 0


def ok(label, condition, detail=""):
    global passed, failed
    print(f"  {'PASS' if condition else 'FAIL'}: {label}" + (f" ({detail})" if detail else ""))
    if condition:
        passed += 1
    else:
        failed += 1


MSG = ("pkg_resources is deprecated as an API. See https://setuptools.pypa.io/en/latest/pkg_resources.html. "
       "The pkg_resources package is slated for removal as early as 2025-11-30.")


def shown(message, category, module):
    with warnings.catch_warnings(record=True) as caught:
        warnings.warn_explicit(message, category, "pkgdata.py", 25, module=module, registry={})
    return [str(w.message)[:60] for w in caught]


print("\n=== pygame's pkg_resources warning (BUG-23) ===\n")
ok("newer setuptools (UserWarning, attributed to pygame): not shown", shown(MSG, UserWarning, "pygame.pkgdata") == [], str(shown(MSG, UserWarning, "pygame.pkgdata")))
ok("older setuptools (DeprecationWarning): not shown", shown(MSG, DeprecationWarning, "pygame.pkgdata") == [])
ok("another warning is still shown", shown("mixer frequency not supported", UserWarning, "pygame.mixer") != [])

print(f"\n=== Results: {passed} passed, {failed} failed ===")
sys.exit(1 if failed else 0)
