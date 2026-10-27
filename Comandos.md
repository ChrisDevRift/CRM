# Recompilar y desplegar el panel:

cd ..\panel
$env:PUBLIC_API_URL = "https://crm-api.luxurytransfersriviera.com.mx"
npm run build
npx wrangler pages deploy dist --project-name crm-panel
Remove-Item Env:PUBLIC_API_URL

# Regenerar Contraseña:

npm run create-admin -- "Christopher Arturo" tucorreo@ejemplo.com admin
npx wrangler d1 execute crm-db --remote --file=crear-usuario.sql
Remove-Item crear-usuario.sql
npx wrangler deploy

# Recompilar y desplegar el api:

cd api
npm run db:migrate:local
npm run db:migrate:remote
npx wrangler deploy

# Ver los logs de la api

Desde api, deja corriendo:

npx wrangler tail crm-api --format pretty

# Para aplicar cambios a las anclas

cd api
npm run db:migrate:local ; npm run db:migrate:remote
node scripts/sync-anclas.mjs src\data\zoneAnchors.json
npx wrangler d1 execute crm-db --remote --file=anclas.sql
Remove-Item anclas.sql
npx wrangler deploy

Después, para el histórico, usa la simulación primero (node scripts/import-sheet.mjs ..\hoja.tsv --dry-run)
