# 20: Live view layout in the run page

**What to build:** Make the live view comfortable to use in the run page. Today the stage panel is short by default, so an operator has to drag the splitter to reach the canvas, and the canvas renders small (about a third of its natural size in a 450 px panel). The login gate should give the live view enough room to read and click, and keep the confirm control reachable.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] When a pending gate has a live view, the canvas is visible without moving any splitter, and is large enough to read a login form.
- [ ] The canvas keeps its aspect ratio and scales down to the panel; clicks still land correctly after resizing (image-size coordinate mapping unchanged).
- [ ] The confirm control and the help text stay reachable without scrolling past the canvas on a typical laptop screen.
- [ ] The layout works in light and dark themes and follows the UI guide (tokens only).
- [ ] A short check with a real browser (screenshot) is recorded in the ticket notes.
