# Bizrunner Backend

This is the backend service for the Bizrunner platform.

## Tech Stack
- **Framework:** Node.js with Express
- **Language:** TypeScript
- **Agent Framework:** LangGraph.js
- **Database ORM:** Drizzle ORM
- **Database:** PostgreSQL

## Project Structure
- `src/agents/`: LangGraph definitions for AI orchestration.
- `src/controllers/`: API route handlers.
- `src/routes/`: API route definitions.
- `src/db/`: Database schema and connection configuration.
- `src/services/`: External platform integrations (Etsy, Canva, etc.).

## Getting Started

### Prerequisites
- Node.js (v18+)
- PostgreSQL (for development, you can use a local instance or a mock)

### Installation
```bash
npm install
```

### Development
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Database Migrations
```bash
npm run db:generate
npm run db:push
```
