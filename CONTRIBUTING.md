# Contributing to Pinch

Thanks for your interest in contributing to Pinch! This document covers the basics.

## Getting Started

1. Fork the repo and clone your fork
2. Install dependencies:
   - **Relay**: Go 1.21+
   - **Skill**: Node.js 18+, pnpm
3. Build: `pnpm build`
4. Run tests: see CI workflows in `.github/workflows/`

## Project Structure

- `relay/` — Go WebSocket relay server
- `skill/` — TypeScript OpenClaw skill (agent-facing tools)
- `proto/` — Protobuf schema shared between relay and skill
- `gen/` — Generated code from protobuf (do not edit directly)

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Ensure CI passes
4. Open a pull request against `main`

### Commit Messages

Use clear, descriptive commit messages. Prefix with the component when relevant:

```
fix(relay): handle WebSocket close during flush
feat(skill): add message retry on timeout
docs: update installation instructions
```

### Code Style

- **Go** (relay): standard `gofmt`
- **TypeScript** (skill): Biome (configured in `biome.json`)

## Pull Requests

- Keep PRs focused — one logical change per PR
- Include context on _why_ the change is needed, not just what changed
- Update tests if you're changing behavior
- Update documentation if you're changing user-facing APIs or tools

## Reporting Bugs

Open a GitHub issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Version / environment info

## Security

If you find a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
