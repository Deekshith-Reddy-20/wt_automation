# Start a DISPOSABLE local database for the migration 058 integration tests:
#   Postgres (Supabase image) on 127.0.0.1:55432 and PostgREST on 127.0.0.1:55433,
#   both on a private Docker network, no volumes (data is lost on `down.ps1`).
# Applies every file in supabase/migrations in order and seeds two fictitious users.
# Never touches the hosted Supabase project or the local `supabase start` stack.
#
#   pwsh scripts/disposable-db/up.ps1
#   $env:WACRM_DISPOSABLE_DB='1'; npx vitest run src/app/api/whatsapp/webhook/disposable-db.integration.test.ts
#   pwsh scripts/disposable-db/down.ps1

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$image = 'public.ecr.aws/supabase/postgres:17.11.0.004'
$rest = 'public.ecr.aws/supabase/postgrest:v16.4'
# Local-only throwaway values; the containers bind to 127.0.0.1 and are removed by down.ps1.
$jwtSecret = 'disposable-local-only-jwt-secret-not-for-prod-0001'

docker network create wacrm058-net | Out-Null
docker run -d --rm --name wacrm058-db --network wacrm058-net -p 127.0.0.1:55432:5432 `
  -e POSTGRES_PASSWORD=postgres -e JWT_SECRET=$jwtSecret $image | Out-Null

for ($i = 0; $i -lt 60; $i++) {
  if ((docker inspect -f '{{.State.Health.Status}}' wacrm058-db) -eq 'healthy') { break }
  Start-Sleep -Seconds 2
}

docker cp (Join-Path $PSScriptRoot 'storage-stub.sql') wacrm058-db:/tmp/storage-stub.sql | Out-Null
docker exec wacrm058-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/storage-stub.sql
if ($LASTEXITCODE -ne 0) { throw 'storage stub failed' }

docker cp (Join-Path $root 'supabase\migrations') wacrm058-db:/tmp/migrations | Out-Null
foreach ($f in Get-ChildItem (Join-Path $root 'supabase\migrations\*.sql') | Sort-Object Name) {
  docker exec wacrm058-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction -q -f "/tmp/migrations/$($f.Name)"
  if ($LASTEXITCODE -ne 0) { throw "migration $($f.Name) failed" }
}

docker cp (Join-Path $PSScriptRoot 'seed-users.sql') wacrm058-db:/tmp/seed-users.sql | Out-Null
docker exec wacrm058-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/seed-users.sql
if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
docker exec wacrm058-db psql -U supabase_admin -d postgres -qc "ALTER ROLE authenticator WITH LOGIN PASSWORD 'postgres'"

docker run -d --rm --name wacrm058-rest --network wacrm058-net -p 127.0.0.1:55433:3000 `
  -e PGRST_DB_URI=postgres://authenticator:postgres@wacrm058-db:5432/postgres `
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_DB_POOL=20 `
  -e PGRST_JWT_SECRET=$jwtSecret $rest | Out-Null

Write-Output 'Disposable database ready: Postgres 127.0.0.1:55432, PostgREST 127.0.0.1:55433'
