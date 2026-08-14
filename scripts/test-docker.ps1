# Docker 環境テストスクリプト
# 使用方法: pwsh scripts/test-docker.ps1
# オプション: pwsh scripts/test-docker.ps1 -Env dev    (開発環境のみ)
#             pwsh scripts/test-docker.ps1 -Env prod   (本番環境のみ)

param(
    [ValidateSet("dev", "prod", "both")]
    [string]$Env = "both"
)

$ErrorActionPreference = "Stop"

function Write-Header { param([string]$Text)
    Write-Host ""
    Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
}

function Write-Step { param([string]$Text)
    Write-Host "  ▶ $Text" -ForegroundColor Yellow
}

function Write-OK { param([string]$Text)
    Write-Host "  ✓ $Text" -ForegroundColor Green
}

function Write-Fail { param([string]$Text)
    Write-Host "  ✗ $Text" -ForegroundColor Red
}

function Wait-ForHealth {
    param([string]$Url, [int]$MaxWaitSec = 60, [string]$Label = "アプリ")
    Write-Step "$Label の起動を待機中... (最大 ${MaxWaitSec}s)"
    $elapsed = 0
    while ($elapsed -lt $MaxWaitSec) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                Write-OK "$Label が起動しました（${elapsed}s 経過）"
                return $resp.Content | ConvertFrom-Json
            }
        } catch {}
        Start-Sleep -Seconds 3
        $elapsed += 3
        Write-Host "    ... ${elapsed}s" -ForegroundColor DarkGray
    }
    throw "$Label が ${MaxWaitSec}s 以内に起動しませんでした。"
}

function Test-DevEnvironment {
    Write-Header "開発環境テスト"
    $compose = "docker compose -f docker-compose.yml"

    try {
        Write-Step "開発環境のコンテナをビルド・起動中..."
        Invoke-Expression "$compose up --build -d" | Out-Null

        # /health チェック
        $health = Wait-ForHealth -Url "http://localhost:3000/health" -MaxWaitSec 90 -Label "開発アプリ"
        Write-OK "/health レスポンス: $($health | ConvertTo-Json -Compress)"

        if ($health.env -ne "development") {
            throw "NODE_ENV が 'development' ではありません: $($health.env)"
        }
        Write-OK "NODE_ENV = development ✓"

        # /api/setup/status チェック
        Write-Step "/api/setup/status を確認中..."
        $setup = Invoke-WebRequest -Uri "http://localhost:3000/api/setup/status" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
        Write-OK "/api/setup/status: needsSetup=$($setup.needsSetup)"

        # /api/session チェック
        Write-Step "/api/session を確認中..."
        $session = Invoke-WebRequest -Uri "http://localhost:3000/api/session" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
        Write-OK "/api/session: user=$($session.user)"

        Write-Host ""
        Write-Host "  ✅ 開発環境テスト: すべて PASSED" -ForegroundColor Green
        return $true
    } catch {
        Write-Fail "開発環境テスト失敗: $_"
        Write-Step "ログを表示..."
        Invoke-Expression "$compose logs --tail=30 app"
        return $false
    } finally {
        Write-Step "開発環境コンテナを停止・削除中..."
        Invoke-Expression "$compose down -v" | Out-Null
        Write-OK "開発環境クリーンアップ完了"
    }
}

function Test-ProdEnvironment {
    Write-Header "本番環境テスト"
    $compose = "docker compose --env-file .env.production -f docker-compose.prod.yml"

    if (-not (Test-Path ".env.production")) {
        Write-Fail ".env.production が見つかりません。.env.production.example をコピーして設定してください。"
        return $false
    }

    try {
        Write-Step "本番環境のコンテナをビルド・起動中..."
        Invoke-Expression "$compose up --build -d" | Out-Null

        # APP_PORT の取得（.env.production から読む）
        $envContent = Get-Content ".env.production" | Where-Object { $_ -match "^APP_PORT=" }
        $appPort = if ($envContent) { ($envContent -split "=")[1].Trim() } else { "3000" }

        # /health チェック
        $health = Wait-ForHealth -Url "http://localhost:${appPort}/health" -MaxWaitSec 90 -Label "本番アプリ"
        Write-OK "/health レスポンス: $($health | ConvertTo-Json -Compress)"

        if ($health.env -ne "production") {
            throw "NODE_ENV が 'production' ではありません: $($health.env)"
        }
        Write-OK "NODE_ENV = production ✓"

        # Docker ヘルスチェックの状態確認
        Write-Step "Docker コンテナのヘルス状態を確認中..."
        Start-Sleep -Seconds 10
        $containers = docker compose --env-file .env.production -f docker-compose.prod.yml ps --format json | ConvertFrom-Json
        foreach ($c in $containers) {
            $healthStatus = if ($c.Health) { $c.Health } else { "N/A" }
            Write-OK "コンテナ: $($c.Name) | State: $($c.State) | Health: $healthStatus"
        }

        # 本番は /api/setup/status のみ確認（認証不要エンドポイント）
        Write-Step "/api/setup/status を確認中..."
        $setup = Invoke-WebRequest -Uri "http://localhost:${appPort}/api/setup/status" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
        Write-OK "/api/setup/status: needsSetup=$($setup.needsSetup)"

        Write-Host ""
        Write-Host "  ✅ 本番環境テスト: すべて PASSED" -ForegroundColor Green
        return $true
    } catch {
        Write-Fail "本番環境テスト失敗: $_"
        Write-Step "ログを表示..."
        Invoke-Expression "$compose logs --tail=30 app"
        return $false
    } finally {
        Write-Step "本番環境コンテナを停止・削除中..."
        Invoke-Expression "$compose --env-file .env.production -f docker-compose.prod.yml down -v" | Out-Null
        Write-OK "本番環境クリーンアップ完了"
    }
}

# ──── メイン実行 ────────────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Split-Path -Parent $scriptDir)

Write-Header "MAC Address Auth Service - Docker テスト"
Write-Host "  対象環境: $Env" -ForegroundColor White

$devResult = $true
$prodResult = $true

if ($Env -eq "dev" -or $Env -eq "both") {
    $devResult = Test-DevEnvironment
}

if ($Env -eq "prod" -or $Env -eq "both") {
    $prodResult = Test-ProdEnvironment
}

Write-Header "テスト結果サマリー"
if ($Env -eq "dev" -or $Env -eq "both") {
    $icon = if ($devResult) { "✅" } else { "❌" }
    Write-Host "  $icon 開発環境: $(if ($devResult) { 'PASSED' } else { 'FAILED' })" -ForegroundColor $(if ($devResult) { "Green" } else { "Red" })
}
if ($Env -eq "prod" -or $Env -eq "both") {
    $icon = if ($prodResult) { "✅" } else { "❌" }
    Write-Host "  $icon 本番環境: $(if ($prodResult) { 'PASSED' } else { 'FAILED' })" -ForegroundColor $(if ($prodResult) { "Green" } else { "Red" })
}
Write-Host ""

if (-not $devResult -or -not $prodResult) {
    exit 1
}
exit 0
