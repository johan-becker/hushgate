# hushgate

Nothing personal leaves the machine.

A local-first PII firewall that sits between your application and a cloud LLM
API. Point your existing OpenAI or Anthropic SDK at hushgate instead of the real
endpoint: it detects personal data in the outgoing request, swaps it for stable
pseudonymous placeholders, forwards the sanitised request upstream, and
re-hydrates the placeholders in the response so your application sees the real
values back. The cloud provider never sees the personal data.

Full documentation lands with the feature branches.

## License

Business Source License 1.1 — see [LICENSE](LICENSE). Copyright (c) 2026 Johan Becker. Converts to the Apache License, Version 2.0 four years after publication.
