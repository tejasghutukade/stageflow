# 09: Virtual display support

**What to build:** Linux Hosts with no display variable and an Xvfb binary report a virtual display and launch headed, relying on agent-browser starting its own Xvfb. Host configuration gains browser launch options (launch arguments, explicit executable path), off by default, computed once into the persisted environment.

**Blocked by:** 01

**Status:** done

- [x] A Linux Host without DISPLAY and with Xvfb on the path reports a virtual display and selects headed; without Xvfb it reports headless-only. macOS and Windows behavior is unchanged.
- [x] Display variables are copied only for a local window, never for a virtual display.
- [x] Host config accepts launch arguments and an executable path; they appear in the persisted anchor environment, are never read from ambient env or YAML, and the byte-identical env tests pass.
- [x] YAML carrying any such option is rejected at load.
- [x] Unit tests inject the platform, environment and Xvfb probe; the internals document's env contract and limitation 8 are updated.
