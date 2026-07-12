$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "   Preparar YRepo Cloud para Aidoku" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$url = Read-Host "Pega la URL publica de Render (ejemplo: https://yrepo-manhwa-cloud.onrender.com)"
$url = $url.Trim().TrimEnd("/")
if (-not $url.StartsWith("https://")) {
    throw "La URL debe comenzar con https://"
}

$token = "yrp_D4CyHVNjrVcFpdR4Fovnxk79SkOBerjV"
$source = Join-Path $root "source-template"
$templateLib = Join-Path $source "src\lib.template.rs"
$lib = Join-Path $source "src\lib.rs"
$templateJson = Join-Path $source "res\source.template.json"
$sourceJson = Join-Path $source "res\source.json"

$libText = [IO.File]::ReadAllText($templateLib)
$libText = $libText.Replace("__YREPO_CLOUD_URL__", $url)
$libText = $libText.Replace("__YREPO_PROXY_TOKEN__", $token)
[IO.File]::WriteAllText($lib, $libText, [Text.UTF8Encoding]::new($false))

$jsonText = [IO.File]::ReadAllText($templateJson)
$jsonText = $jsonText.Replace("__YREPO_CLOUD_URL__", $url)
[IO.File]::WriteAllText($sourceJson, $jsonText, [Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "[1/3] Compilando la fuente..." -ForegroundColor Yellow
aidoku package $source
if ($LASTEXITCODE -ne 0) { throw "Falló aidoku package" }

$package = Join-Path $source "package.aix"
Write-Host ""
Write-Host "[2/3] Verificando..." -ForegroundColor Yellow
aidoku verify $package
if ($LASTEXITCODE -ne 0) { throw "La fuente no pasó la verificación" }

Write-Host ""
Write-Host "[3/3] Creando la lista pública..." -ForegroundColor Yellow
$public = Join-Path $root "public"
if (Test-Path $public) {
    Get-ChildItem $public -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $public | Out-Null
}
aidoku build $package -o $public
if ($LASTEXITCODE -ne 0) { throw "Falló aidoku build" }

Write-Host ""
Write-Host "LISTO." -ForegroundColor Green
Write-Host "Ahora sube los cambios a GitHub para que Render vuelva a desplegar."
Write-Host "La lista permanente quedará en:"
Write-Host "$url/index.min.json" -ForegroundColor Cyan
Read-Host "Presiona Enter para cerrar"
