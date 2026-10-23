# Despliega pub-sync en AWS: pila de CloudFormation (colas, dos Lambdas, API)
# y el codigo de las dos funciones. Solo necesita el AWS CLI y Node. Sin SAM
# ni CDK, igual que el resto de pilas de Silbon.
#
# Uso:
#   npm run aws:deploy -- -ShopDomain silbon-store.myshopify.com `
#     -CentralLocationId 12345678901 `
#     -MarketIds "gid://shopify/Market/1,gid://shopify/Market/2"
#
#   Con dominio propio (certificado ACM REGIONAL, en eu-central-1):
#   npm run aws:deploy -- ... -DomainName pub-sync.silbon.es `
#     -CertificateArn arn:aws:acm:eu-central-1:...:certificate/...
#
#   Solo subir codigo (la pila no cambia):
#   npm run aws:deploy -- -SkipStack
#
# Al terminar imprime la URL del webhook: hay que ponerla en la suscripcion
# inventory_levels/update de la app en Shopify (scripts/update-webhook.mjs).

[CmdletBinding()]
param(
  [string]$StackName = 'silbon-pub-sync',
  [string]$Region = 'eu-central-1',
  [string]$SecretsPrefix = '/silbon/pub-sync',
  [string]$ShopDomain = $env:SHOP_DOMAIN,
  [string]$CentralLocationId = $env:CENTRAL_LOCATION_ID,
  [string]$MarketIds = $env:MARKET_IDS,
  [int]$DebounceSeconds = 8,
  # Dominio propio opcional. Vacio = URL de execute-api.
  [string]$DomainName = '',
  [string]$CertificateArn = $env:PUBSYNC_CERTIFICATE_ARN,
  [string]$HostedZoneId = 'ZDE8KK068AVPG',
  # Salta la pila: solo empaqueta y sube el codigo.
  [switch]$SkipStack
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $SkipStack) {
  foreach ($pair in @(
    @('ShopDomain', $ShopDomain),
    @('CentralLocationId', $CentralLocationId),
    @('MarketIds', $MarketIds)
  )) {
    if (-not $pair[1]) { throw "Falta -$($pair[0]) (o su variable de entorno)." }
  }
  if ($DomainName -and -not $CertificateArn) {
    throw 'Con -DomainName hace falta -CertificateArn (certificado ACM en la misma region que la pila).'
  }
}

function Get-StackOutput([string]$key) {
  $outputs = (aws cloudformation describe-stacks --stack-name $StackName --region $Region --output json | ConvertFrom-Json).Stacks[0].Outputs
  $salida = $outputs | Where-Object { $_.OutputKey -eq $key }
  if ($salida) { return $salida.OutputValue }
  return $null
}

# --- 1. Comprobar los secretos en SSM ----------------------------------------
# El script nunca pide ni escribe secretos: si falta alguno, imprime el
# comando para que lo cree quien tenga las claves.
$requiredSecrets = @('SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_WEBHOOK_SECRET')

Write-Host 'Comprobando secretos en SSM Parameter Store...' -ForegroundColor Cyan
$names = $requiredSecrets | ForEach-Object { "$SecretsPrefix/$_" }
$existing = @()
try {
  $result = aws ssm get-parameters --names $names --region $Region --output json | ConvertFrom-Json
  $existing = @($result.Parameters | ForEach-Object { $_.Name })
} catch {
  Write-Warning "No se pudo consultar SSM: $($_.Exception.Message)"
}

$missingRequired = @($names | Where-Object { $existing -notcontains $_ })
if ($missingRequired.Count -gt 0) {
  Write-Host ''
  Write-Host 'Faltan estos parametros. Crealos tu (no los pide este script):' -ForegroundColor Yellow
  foreach ($name in $missingRequired) {
    Write-Host "  aws ssm put-parameter --name $name --type SecureString --value '<valor>' --region $Region" -ForegroundColor Yellow
  }
  throw "Faltan $($missingRequired.Count) secretos en SSM."
}

if (-not $SkipStack) {
  # --- 2. Desplegar la pila --------------------------------------------------
  Write-Host "Desplegando la pila $StackName en $Region..." -ForegroundColor Cyan
  aws cloudformation deploy `
    --template-file "$PSScriptRoot/template.yaml" `
    --stack-name $StackName `
    --region $Region `
    --capabilities CAPABILITY_IAM `
    --no-fail-on-empty-changeset `
    --parameter-overrides `
      "SecretsPrefix=$SecretsPrefix" `
      "ShopDomain=$ShopDomain" `
      "CentralLocationId=$CentralLocationId" `
      "MarketIds=$MarketIds" `
      "DebounceSeconds=$DebounceSeconds" `
      "DomainName=$DomainName" `
      "CertificateArn=$CertificateArn" `
      "HostedZoneId=$HostedZoneId"
  if ($LASTEXITCODE -ne 0) { throw 'cloudformation deploy fallo' }
}

# --- 3. Empaquetar y subir el codigo a las dos funciones ----------------------
# El zip lleva src/ y server/ con las dependencias de produccion (ninguna:
# el SDK de AWS viene en el runtime y express/morgan/dotenv son solo del
# servidor local). El mismo zip sirve para el receptor y el worker; cambia
# el handler.
$buildDir = Join-Path $repoRoot 'build-lambda'
$stageDir = Join-Path $buildDir 'stage'
$zipPath = Join-Path $buildDir 'function.zip'

Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
foreach ($dir in @('src', 'server')) {
  Copy-Item -Path (Join-Path $repoRoot $dir) -Destination (Join-Path $stageDir $dir) -Recurse
}
foreach ($file in @('package.json', 'package-lock.json')) {
  Copy-Item -Path (Join-Path $repoRoot $file) -Destination (Join-Path $stageDir $file)
}

Write-Host 'Instalando dependencias de produccion de la Lambda...' -ForegroundColor Cyan
Push-Location $stageDir
try {
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { throw 'npm ci fallo' }
} finally {
  Pop-Location
}

Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -Force

foreach ($key in @('WebhookFunctionName', 'WorkerFunctionName')) {
  $fn = Get-StackOutput $key
  if (-not $fn) { throw "La pila no expone $key" }
  Write-Host "Subiendo codigo a $fn..." -ForegroundColor Cyan
  aws lambda update-function-code --function-name $fn --zip-file "fileb://$zipPath" --region $Region --publish --output json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "update-function-code fallo en $fn" }
  aws lambda wait function-updated --function-name $fn --region $Region
}

# --- 4. Comprobar que responde ------------------------------------------------
$publicUrl = Get-StackOutput 'PublicUrl'
try {
  $health = Invoke-RestMethod -Uri "$publicUrl/health" -TimeoutSec 30
  Write-Host "Health: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  Write-Warning "El health check no respondio: $($_.Exception.Message)"
}

$webhookUrl = Get-StackOutput 'WebhookUrl'
Write-Host ''
Write-Host 'Despliegue completado.' -ForegroundColor Green
Write-Host "URL del webhook: $webhookUrl"
Write-Host "Cola: $(Get-StackOutput 'QueueName')   DLQ: $(Get-StackOutput 'DeadLetterQueueName')"
Write-Host ''
Write-Host 'Si es el primer despliegue o cambio la URL, apunta la suscripcion de Shopify a la URL nueva:' -ForegroundColor Yellow
Write-Host "  `$env:SECRETS_SSM_PREFIX='$SecretsPrefix'; `$env:SHOP_DOMAIN='$ShopDomain'; node scripts/update-webhook.mjs $webhookUrl"
