---
layout: default
title: Console - Settings
---

# Settings

`#/settings`, reached from the footer of the app rail. A left nav lists six sections; the content is centered.

| Section | What it does |
|---------|--------------|
| [General](#general) | Workshop model and disk usage |
| [Providers](#providers) | Model providers |
| [Concurrency](#concurrency) | Agent slots |
| [MCP server](#mcp-server) | How a client reaches this console over MCP |
| [Project MCP](#project-mcp) | MCP servers and their secrets and sign-ins |
| [Notifications](#notifications) | Desktop notifications |

The console is dark; there is no theme picker.

## General

The **Workshop model** (see [Workshop Author, Model](workshop.md#model)) and how much disk the runs use and how much is free on the volume.

## Providers

Connect, disconnect and inspect Pi model providers (`pi_home` vs `sf_owned`). See [Providers](providers.md).

## Concurrency

**Agent slots**: how many agent sessions (stage sessions and chat agents) may be alive at once, set with the Decrease and Increase controls. A stage waiting on you still holds its slot.

## MCP server

The address a client points at to use this console process as an MCP server (`<console-origin>/mcp` while `sf ui` is running). See [MCP](mcp.md).

## Project MCP

The tool servers agents and stages can use. The panel has two parts. Full reference (formats, secret rules, OAuth, security): [MCP servers](mcp-servers.md).

- **Project MCP**: the server list. Servers from the project `.mcp.json` are read-only here; servers saved from the console (stored on the Host, not in the project) can be added (**Add server**, or paste a snippet from the server's docs), edited and removed. **Check** connects and lists the server's tools; **Sign in** runs the OAuth flow for servers that need it (agents and Check use it, pipeline stages do not); **Sign out** drops it.
- **MCP secrets**: values for the `${NAME}` placeholders in server configs. Stored on the Host and never shown again. Enter a value to set or replace it; remove to delete.

## Notifications

One switch: **Desktop notification when a gate opens** (system notification or off). It covers both pipeline gates ("Stage waiting on you") and agent approvals ("Agent waiting on you"). The browser asks for permission when you turn it on; if it is blocked the section says so. A held stage or pending approval is invisible if the console tab is closed.
