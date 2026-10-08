# prompt-hud

A Claude Code mod: one band above the prompt showing the context window by category (with the compaction threshold), token counts, and 5h / weekly plan limits.

Not a novel idea, just a tidy one.

## Install

```
/plugin marketplace add unshDee/prompt-hud
/plugin install prompt-hud@prompt-hud
```

Source is a single file: `prompt-hud/hooks/register.tsx`. It uses the Claude Code mods hook API and its type definitions (`types/`), which are not bundled here.
