db:
	@docker run -d --name my-postgres -e POSTGRES_PASSWORD=mysecretpassword -p 5432:5432 pgvector/pgvector:pg16 && pnpm migrate && pnpm studio