# Remove the disposable database started by up.ps1 (containers run with --rm,
# so stopping them deletes all data). Touches nothing else.
docker stop wacrm058-rest wacrm058-db 2>$null | Out-Null
docker network rm wacrm058-net 2>$null | Out-Null
Write-Output 'Disposable database removed.'
