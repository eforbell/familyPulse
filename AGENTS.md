# Agent Learnings

## Web UI: iOS Input Auto-Zoom Guard

- iOS Safari/WKWebView auto-zooms focused text-entry controls when their computed font-size is below 16px; keep interactive `input`, `select`, and `textarea` controls at `font-size: 1rem` minimum
- Avoid reintroducing small-font form controls through tokens, mobile overrides, or inline styles; if display copy needs to stay smaller, size labels/help text separately from the actual control
