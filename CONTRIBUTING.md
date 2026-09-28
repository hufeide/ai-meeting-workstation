# Contributing

Thanks for taking the time to improve AI Discussion.

## Local Setup

```bash
npm install
cp .env.example .env
npm run doctor
npm run dev
```

## Before Opening a PR

Please run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Pull Requests

- Keep changes focused and explain the user-facing behavior.
- Update docs when changing setup, configuration, API shape, or product flow.
- Do not commit `.env`, `.local-data/`, local recordings, local databases, or personal workspace metadata.

## Issues

Use the issue templates for bug reports, feature requests, and spec tasks. Include reproduction steps and environment details when reporting bugs.
