param(
  [string]$HostName = "192.168.10.113",
  [string]$User = "root",
  [string]$RemoteDir = "/opt/demiurge-ai-canvas",
  [int]$PublicPort = 80,
  [string]$DockerBaseRegistry = "docker.m.daocloud.io/library",
  [string]$NpmRegistry = "https://mirrors.huaweicloud.com/repository/npm/",
  [switch]$InitData,
  [switch]$SkipLocalChecks
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$remote = "$User@$HostName"
$tmpName = "demiurge-ai-canvas-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$tmpRoot = "/tmp/$tmpName"
$codeArchive = Join-Path ([System.IO.Path]::GetTempPath()) "$tmpName-code.tar.gz"
$dataArchive = Join-Path ([System.IO.Path]::GetTempPath()) "$tmpName-data.tar.gz"

function Invoke-Checked {
  param(
    [string]$Command,
    [string]$WorkingDirectory = $repoRoot
  )
  Write-Host ">> $Command"
  Push-Location $WorkingDirectory
  try {
    pwsh -NoProfile -Command $Command
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code $LASTEXITCODE`: $Command"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-Remote {
  param([string]$Command)
  Write-Host ">> ssh $remote `"$Command`""
  ssh $remote $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Remote command failed with exit code $LASTEXITCODE"
  }
}

function Copy-Remote {
  param(
    [string]$LocalPath,
    [string]$RemotePath
  )
  Write-Host ">> scp $LocalPath $remote`:$RemotePath"
  scp $LocalPath "$remote`:$RemotePath"
  if ($LASTEXITCODE -ne 0) {
    throw "scp failed with exit code $LASTEXITCODE"
  }
}

try {
  Write-Host "Deploy target: ${remote}:$RemoteDir"
  Write-Host "Public port: $PublicPort"
  Write-Host "Docker base registry: $DockerBaseRegistry"
  Write-Host "NPM registry: $NpmRegistry"

  if (-not $SkipLocalChecks) {
    Invoke-Checked "npm run build" (Join-Path $repoRoot "frontend")
    Invoke-Checked "npm run verify" (Join-Path $repoRoot "backend/node")
    Invoke-Checked "python -m py_compile app/image_generate_service.py app/main.py app/core/config.py app/core/media_paths.py test_image_generate.py" (Join-Path $repoRoot "backend/python")
  }

  $portCheck = @"
set -e
if ss -ltn "( sport = :$PublicPort )" | tail -n +2 | grep -q .; then
  if [ -f '$RemoteDir/docker-compose.yml' ]; then
    cd '$RemoteDir'
    current_port=`$(docker compose port web-gateway 80 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)`$/\1/p' | tail -n 1 || true)
    if [ "`$current_port" = "$PublicPort" ]; then
      echo "Port $PublicPort is already used by the existing demiurge-ai-canvas deployment; continuing."
      exit 0
    fi
  fi
  echo "Port $PublicPort is already in use on $HostName by another service. Choose another port with -PublicPort, for example -PublicPort 8080." >&2
  exit 21
fi
"@
  Invoke-Remote $portCheck

  $codeExcludes = @(
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=logs",
    "--exclude=tools/ffmpeg-dist",
    "--exclude=*.log"
  )
  $codeIncludes = @(
    ".gitignore",
    "AGENT.md",
    "README.md",
    "docker-compose.yml",
    "frontend",
    "backend",
    "docs",
    "tools",
    "deploy"
  )

  if (Test-Path $codeArchive) { Remove-Item -LiteralPath $codeArchive -Force }
  Write-Host ">> Creating code archive"
  Push-Location $repoRoot
  try {
    tar @codeExcludes -czf $codeArchive @codeIncludes
  } finally {
    Pop-Location
  }

  Invoke-Remote "mkdir -p '$tmpRoot' '$RemoteDir' '$RemoteDir/data/projects' '$RemoteDir/data/material-library' '$RemoteDir/data/outputs'"
  Copy-Remote $codeArchive "$tmpRoot/code.tar.gz"
  Invoke-Remote "test -n '$RemoteDir' && test '$RemoteDir' != '/' && find '$RemoteDir' -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} + && tar -xzf '$tmpRoot/code.tar.gz' -C '$RemoteDir'"

  $composeEnv = "PUBLIC_PORT=$PublicPort`nDOCKER_BASE_REGISTRY=$DockerBaseRegistry`nNPM_REGISTRY=$NpmRegistry`n"
  $composeEnvPath = Join-Path ([System.IO.Path]::GetTempPath()) "$tmpName-compose.env"
  Set-Content -LiteralPath $composeEnvPath -Value $composeEnv -NoNewline -Encoding ascii
  Copy-Remote $composeEnvPath "$RemoteDir/.env"

  if ($InitData) {
    if (Test-Path $dataArchive) { Remove-Item -LiteralPath $dataArchive -Force }
    Write-Host ">> Creating data archive"
    Push-Location $repoRoot
    try {
      tar -czf $dataArchive projects material-library outputs
    } finally {
      Pop-Location
    }
    Copy-Remote $dataArchive "$tmpRoot/data.tar.gz"
    Invoke-Remote "tar -xzf '$tmpRoot/data.tar.gz' -C '$RemoteDir/data' --strip-components=0"
  } else {
    Write-Host ">> Data sync skipped. Use -InitData only for first deployment or explicit re-initialization."
  }

  $deployCommand = @"
set -e
cd '$RemoteDir'
docker compose build
docker compose up -d
docker compose ps
for i in `$(seq 1 30); do
  if curl -fsS 'http://127.0.0.1:$PublicPort/api/node/health' >/dev/null \
    && curl -fsS 'http://127.0.0.1:$PublicPort/api/media/health' >/dev/null; then
    exit 0
  fi
  sleep 2
done
echo 'Health checks did not pass after waiting for services to start.' >&2
exit 22
"@
  Invoke-Remote $deployCommand

  Invoke-Remote "rm -rf '$tmpRoot'"

  $url = if ($PublicPort -eq 80) { "http://$HostName" } else { "http://$HostName`:$PublicPort" }
  Write-Host ""
  Write-Host "Deployment complete: $url"
  Write-Host "Node health: $url/api/node/health"
  Write-Host "Media health: $url/api/media/health"
} finally {
  if (Test-Path $codeArchive) { Remove-Item -LiteralPath $codeArchive -Force }
  if (Test-Path $dataArchive) { Remove-Item -LiteralPath $dataArchive -Force }
  if ($composeEnvPath -and (Test-Path $composeEnvPath)) { Remove-Item -LiteralPath $composeEnvPath -Force }
}
