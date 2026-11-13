# Production MF Copilot Instructions

Read the repository root `AGENTS.md` and the relevant `.agents/skills/<skill-name>/SKILL.md` before implementing changes. In particular, apply test-driven-development, security-and-hardening, api-and-interface-design, incremental-implementation, debugging-and-error-recovery, and code-review-and-quality as appropriate.

This is an offline-first production-management system. Never overwrite local tasks silently, bypass transactional outbox writes, auto-sync demo records, or fake successful synchronization. Run web and server typechecks/tests/builds before claiming success.
