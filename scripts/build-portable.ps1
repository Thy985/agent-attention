# Portable build script for Agent Attention v0.2.0
param(
    [string]$Version = "0.2.0",
    [string]$OutputDir = "$PSScriptRoot\..\dist\portable",
    [switch]$SkipDownload
)

$ErrorActionPreference = "Stop"
$NodeVersion = "22.23.2"
$NodeArch = "win-x64"
$AppName = "agent-attention"
$PackageZipName = "$AppName-$Version-$NodeArch.zip"
$NodeBaseUrl = "https://nodejs.org/dist/latest-v$($NodeVersion.Split('.')[0]).x"

Write-Host "=== Agent Attention Portable Builder v$Version ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Build TypeScript ───────────────────────────────────────────────
Write-Host "[1/5] Building TypeScript..." -ForegroundColor Yellow
Push-Location $PSScriptRoot\..
npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: TypeScript build failed" -ForegroundColor Red
    Pop-Location; exit 1
}
Write-Host "      OK" -ForegroundColor Green

# ── 2. Build C# UI ────────────────────────────────────────────────────
Write-Host "[2/5] Building C# UI..." -ForegroundColor Yellow
npm run publish:ui 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: C# build failed" -ForegroundColor Red
    Pop-Location; exit 1
}
Write-Host "      OK" -ForegroundColor Green
Pop-Location

# ── 3. Download Node.js portable ──────────────────────────────────────
Write-Host "[3/5] Preparing Node.js portable..." -ForegroundColor Yellow
$nodeDir = Join-Path $OutputDir "node"
$nodeZipUrl = "$NodeBaseUrl/node-v$NodeVersion-$NodeArch.zip"

if (-not (Test-Path $nodeDir)) {
    if ($SkipDownload) {
        Write-Host "      SKIPPED (use -SkipDownload when Node.js is already extracted)" -ForegroundColor Gray
    } else {
        $tempZip = Join-Path $env:TEMP "node-${NodeVersion}-${NodeArch}.zip"
        if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

        Write-Host "      Downloading from $nodeZipUrl" -ForegroundColor Gray
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $nodeZipUrl -OutFile $tempZip -UseBasicParsing
            $ProgressPreference = 'Continue'
            $zipSize = [math]::Round((Get-Item $tempZip).Length / 1MB, 1)
            Write-Host "      Downloaded $zipSize MB" -ForegroundColor Gray
        } catch {
            Write-Host "      Download failed: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "      Manual download: $nodeZipUrl" -ForegroundColor Yellow
            exit 1
        }

        Write-Host "      Extracting..." -ForegroundColor Gray
        Expand-Archive -Path $tempZip -DestinationPath $OutputDir -Force
        $extracted = Get-ChildItem $OutputDir -Directory | Where-Object { $_.Name -match "node-v" }
        if ($extracted) {
            Move-Item -Path $extracted.FullName -Destination $nodeDir -Force
            Remove-Item $extracted.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "      Node.js already present" -ForegroundColor Gray
}

# ── 4. Install npm dependencies ──────────────────────────────────────
Write-Host "[4/5] Installing dependencies..." -ForegroundColor Yellow
if (-not (Test-Path (Join-Path $nodeDir "node_modules\agent-attention"))) {
    $stageDir = Join-Path $OutputDir "_staging"
    if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

    Copy-Item -Path "dist" -Destination (Join-Path $stageDir "dist") -Recurse -Force
    $csharpSrc = "src\center\csharp\dist\win-x64"
    $csharpDst = Join-Path $stageDir "src\center\csharp\dist\win-x64"
    New-Item -ItemType Directory -Path (Split-Path $csharpDst -Parent) -Force | Out-Null
    Copy-Item -Path $csharpSrc -Destination $csharpDst -Recurse -Force
    Copy-Item -Path "skills" -Destination (Join-Path $stageDir "skills") -Recurse -Force
    Copy-Item -Path "scripts\adapters" -Destination (Join-Path $stageDir "scripts\adapters") -Recurse -Force
    Copy-Item -Path "package.json" -Destination (Join-Path $stageDir "package.json") -Force
    Copy-Item -Path "README.md" -Destination (Join-Path $stageDir "README.md") -Force
    Copy-Item -Path "scripts\portable\start.ps1" -Destination (Join-Path $stageDir "start.ps1") -Force

    Push-Location $stageDir
    & (Join-Path $nodeDir "node.exe") (Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js") install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | Out-Null
    Pop-Location

    Move-Item -Path (Join-Path $stageDir "node_modules") -Destination $nodeDir -Force
    Remove-Item $stageDir -Recurse -Force
} else {
    Write-Host "      Dependencies already installed" -ForegroundColor Gray
}
Write-Host "      OK" -ForegroundColor Green

# ── 5. Create ZIP package ─────────────────────────────────────────────
Write-Host "[5/5] Creating package..." -ForegroundColor Yellow
$packagePath = Join-Path $OutputDir $PackageZipName
if (Test-Path $packagePath) { Remove-Item $packagePath -Force }

$zipStage = Join-Path $env:TEMP "zip-stage-$AppName"
if (Test-Path $zipStage) { Remove-Item $zipStage -Recurse -Force }
New-Item -ItemType Directory -Path $zipStage -Force | Out-Null

Copy-Item -Path $nodeDir -Destination (Join-Path $zipStage "node") -Recurse -Force
Copy-Item -Path "dist" -Destination (Join-Path $zipStage "dist") -Recurse -Force
Copy-Item -Path "skills" -Destination (Join-Path $zipStage "skills") -Recurse -Force
Copy-Item -Path "scripts\adapters" -Destination (Join-Path $zipStage "scripts\adapters") -Recurse -Force
Copy-Item -Path "scripts\portable\start.ps1" -Destination (Join-Path $zipStage "start.ps1") -Force
Copy-Item -Path "README.md" -Destination (Join-Path $zipStage "README.md") -Force

Compress-Archive -Path (Join-Path $zipStage "*") -DestinationPath $packagePath -Force
Remove-Item $zipStage -Recurse -Force

$pkgSize = [math]::Round((Get-Item $packagePath).Length / 1MB, 1)
Write-Host "      Package: $packagePath ($pkgSize MB)" -ForegroundColor Green

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Package: $packagePath"
Write-Host ""
Write-Host "Contents:"
Write-Host "  node\               - Node.js $NodeVersion portable runtime"
Write-Host "  dist\               - TypeScript compiled code"
Write-Host "  skills\             - Integration skill files"
Write-Host "  scripts\adapters\   - Agent adapter registry"
Write-Host "  start.ps1           - One-click launcher"
Write-Host "  README.md           - Quick start guide"
Write-Host ""
Write-Host "To distribute: upload $PackageZipName"
Write-Host "To use:        extract, then run: pwsh start.ps1"
