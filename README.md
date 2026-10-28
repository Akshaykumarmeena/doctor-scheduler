# doctor-scheduler

a scheduling platform that cannot double-book, keeps working when parts of it fail, and fills empty and no-show slots automatically

## Quick start

Needs Node 20+ and Docker Desktop (about 2 GB of RAM free for the containers).

1. `npm install`
2. `npm run dev:infra` – starts Postgres, Redis, Redpanda (+ Console) and OpenSearch, waiting until all are healthy
3. `npm run db:migrate` – creates the schema
4. `npm run db:seed && npm run db:materialize` – about 5,000 Bengaluru doctors, 300 patients, and 14 days of slots
5. `npm run dev` – then open http://localhost:3000 (web), http://localhost:4000/health (API) and http://localhost:8080 (Redpanda Console)

Run the checks with `npm run lint`, `npm run typecheck` and `npm test`. Stop the containers with `npm run down:infra`.

## Read next

- [CLAUDE.md](CLAUDE.md) – architecture, invariants and commands
- [docs/learning/01-foundations.md](docs/learning/01-foundations.md) – what Phase 1 sets up and why
- [docs/decisions/0001-stack.md](docs/decisions/0001-stack.md) – why this stack
