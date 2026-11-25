# ui-showcase

A catalog that fills the Artifacts page with every kind of artifact, so the console renderers can be reviewed by eye.

| Artifacts | Kind | Shows |
|-----------|------|-------|
| `demo-notes`, `demo-metrics`, `demo-text`, `demo-card` | static | Markdown, sortable table, plain text, HTML with no script |
| `demo-gallery` | `live.declarative`, no bindings | Every component in the OpenUI library with inline data |
| `demo-sales` | `live.declarative` | `Select` filter on `$region` (variant queries), line and bar charts, stats, table |
| `demo-health` | `live.declarative` | Table of services, status pills, refresh |
| `demo-html-sales` | `live.html` | Chart.js with region buttons calling the `sales` binding |
| `demo-html-d3` | `live.html` | D3 bars, no bindings |
| `demo-html-health` | `live.html` | ECharts bound to `service_health` |

The two functions (`sales_by_week`, `service_health`) are read-only and need no network. Their values drift every minute, so **Refresh now** visibly changes the data. Live HTML needs the sandbox listener (see [Docker](../../docs/docker.md)).

## Publish without a model

`seed.sh` publishes all ten with `sf artifact publish` under owner `stage:showcase:showcase`. Run it again to publish new versions.

```bash
./examples/ui-showcase/seed.sh "$PWD/examples/ui-showcase"
```

In Docker, mount this folder at `/catalog/ui-showcase`, add that path to `STAGEFLOW_ENSURE_PROJECT_ROOTS`, then:

```bash
docker exec <container> sh /catalog/ui-showcase/seed.sh /catalog/ui-showcase
```

## Generate with a model

`showcase.pipeline.yaml` has one stage that writes five artifacts (`showcase-*`) from the same functions, so a model has to produce valid OpenUI programs. Set the stage `model` first (it defaults to an OpenRouter Claude model).

```bash
cd examples/ui-showcase
sf run --pipeline showcase.pipeline.yaml --task showcase.task.yaml
```
