# Guide (console chat)

The **Guide** (`#/guide`) is the built-in operator assistant for deciding what to build on Stageflow. It can call the same Stageflow tools a person could grant to an agent, plus a few Guide-only tools.

## Cards in the chat

- **show_ui** draws the fixed console cards: plans, choices, pipeline and resource summaries, eval reports, and console links.
- **present_ui** draws generative cards in the thread: declarative charts and tables (`live.declarative`), markdown (`static.markdown`), and when the Host's sandbox is reachable, self-contained HTML (`live.html`). Cards stay in the chat message (full program stored in the thread file) so you can scroll back to them after a restart. The Guide plots only numbers its tools returned; it does not estimate or compute its own figures. Run counts over time or by pipeline come from **run_stats** (grouped on `created_at`), not from counting a `get_run` list.
- **save_card** keeps a card from this chat as a project artifact owned by the Guide (owner `guide`, key `guide/<id>`). The Guide copies the program stored on the `present_ui` call, so it does not draw the card again; that stored copy has secrets redacted, like everything the Guide keeps in a thread. Saving the same card again returns the artifact it already made. A card can be saved from a later message than the one that drew it. It goes into the Guide's default project, and the chat shows the saved artifact with a link to Artifacts.

To change a generative card, ask in a follow-up message and the Guide redraws the whole card with **present_ui**. To keep one, ask to save it.