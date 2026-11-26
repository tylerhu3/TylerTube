<#
.SYNOPSIS
    Smart, resumable Windows setup script for TylerTube.

.DESCRIPTION
    Checks and installs all TylerTube runtime and build dependencies on Windows:
      - Git
      - Node.js LTS (>= 18.15)
      - Python 3 (>= 3.9, ignoring the Windows Store stub)
      - FFmpeg & FFprobe
      - yt-dlp
      - cloudflared (Cloudflare quick tunnels)
      - Nginx for Windows (installed to C:\nginx by default)
      - npm project dependencies (node_modules)
      - redirect-site/ git submodule check
      - .env scaffolding & Git/GitHub readiness checks

    Safe to re-run at any time: already-installed tools meeting version requirements
    are skipped, failures are recorded without aborting remaining steps, and a full
    summary of installed items, manual actions, and next steps is printed at the end.

.PARAMETER NginxDir
    Target directory for Nginx for Windows (default: C:\nginx).

.PARAMETER SkipNpmInstall
    Skip running `npm install` even if inside the TylerTube repository.

.PARAMETER SkipVerify
    Skip running `npm run check` and `npm test` at the end.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1 -NginxDir "D:\nginx"
#>

[CmdletBinding()]
param(
    [string]$NginxDir = "C:\nginx",
    [switch]$SkipNpmInstall,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

# ---------- Reporting buckets ----------
$AlreadyInstalled = [System.Collections.Generic.List[string]]::new()
$NewlyInstalled   = [System.Collections.Generic.List[string]]::new()
$ManualActions    = [System.Collections.Generic.List[string]]::new()

function Write-Header([string]$Text) {
    Write-Host ""
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "  [OK]   $Text" -ForegroundColor Green
}

function Write-Info([string]$Text) {
    Write-Host "  [INFO] $Text" -ForegroundColor Gray
}

function Write-Warn([string]$Text) {
    Write-Host "  [WARN] $Text" -ForegroundColor Yellow
}

function Write-Fail([string]$Text) {
    Write-Host "  [FAIL] $Text" -ForegroundColor Red
}

function Refresh-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
    $combined    = @($machinePath, $userPath) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd(";") }
    $env:Path    = ($combined -join ";")
}

function Add-ToUserPath([string]$Dir) {
    if (-not (Test-Path $Dir)) { return }
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($current) { $parts = $current.Split(";") | Where-Object { $_ -ne "" } }
    $normalized = $Dir.TrimEnd("\").ToLowerInvariant()
    $exists = $parts | Where-Object { $_.TrimEnd("\").ToLowerInvariant() -eq $normalized }
    if (-not $exists) {
        $newPath = (($parts + $Dir) -join ";")
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Refresh-SessionPath
        Write-Info "Added $Dir to User PATH"
    }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-CmdOutput([string]$Exe, [string[]]$Args) {
    try {
        $out = & $Exe @Args 2>&1
        if ($LASTEXITCODE -eq 0) {
            return ($out | Out-String).Trim()
        }
    } catch {
        # ignore
    }
    return $null
}

function Parse-Version([string]$Text) {
    if (-not $Text) { return $null }
    if ($Text -match "(\d+)\.(\d+)(?:\.(\d+))?") {
        $maj = [int]$Matches[1]
        $min = [int]$Matches[2]
        $pat = if ($Matches[3]) { [int]$Matches[3] } else { 0 }
        return [version]::new($maj, $min, $pat)
    }
    return $null
}

$HasWinget = Test-Command "winget"

function Install-WingetPackage {
    param(
        [string]$DisplayName,
        [string]$PackageId,
        [string]$ManualHint
    )
    if (-not $HasWinget) {
        Write-Fail "$DisplayName is missing and winget is not available."
        $ManualActions.Add("$DisplayName`: $ManualHint")
        return $false
    }
    Write-Info "Installing $DisplayName via winget ($PackageId)..."
    try {
        & winget install --id $PackageId --exact --accept-source-agreements --accept-package-agreements --silent
        if ($LASTEXITCODE -ne 0) {
            # Retry once without --silent in case the installer requires interactive UI
            Write-Warn "Silent install returned exit $LASTEXITCODE; retrying interactively..."
            & winget install --id $PackageId --exact --accept-source-agreements --accept-package-agreements
        }
        Refresh-SessionPath
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        Write-Fail "winget failed to install $DisplayName (exit $LASTEXITCODE)."
        $ManualActions.Add("$DisplayName`: $ManualHint")
        return $false
    } catch {
        Write-Fail "Failed installing $DisplayName`: $($_.Exception.Message)"
        $ManualActions.Add("$DisplayName`: $ManualHint")
        return $false
    }
}

function Resolve-Python {
    # Skip the WindowsApps Microsoft Store alias stub by actually executing --version.
    $candidates = @(
        @{ Exe = "python";  Args = @("--version") },
        @{ Exe = "py";      Args = @("-3", "--version") },
        @{ Exe = "python3"; Args = @("--version") }
    )
    foreach ($c in $candidates) {
        $cmd = Get-Command $c.Exe -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        if ($cmd.Source -like "*\WindowsApps\*") { continue }
        $out = Get-CmdOutput $c.Exe $c.Args
        $ver = Parse-Version $out
        if ($ver) {
            return @{ Exe = $c.Exe; Path = $cmd.Source; Version = $ver; Raw = $out }
        }
    }
    return $null
}

function Find-ExistingNginx {
    $candidates = @()
    if ($env:NGINX_DIR) { $candidates += $env:NGINX_DIR }
    $cmd = Get-Command "nginx" -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $candidates += (Split-Path -Parent $cmd.Source) }
    $candidates += @($NginxDir, "C:\nginx", "C:\tools\nginx")
    if ($env:ProgramData) {
        $candidates += (Join-Path $env:ProgramData "chocolatey\lib\nginx\tools")
    }
    foreach ($dir in ($candidates | Select-Object -Unique)) {
        if ($dir -and (Test-Path (Join-Path $dir "nginx.exe"))) {
            return $dir
        }
    }
    return $null
}

function Install-NginxWindows([string]$TargetDir) {
    $fallbackUrl = "https://nginx.org/download/nginx-1.26.3.zip"
    $downloadUrl = $fallbackUrl
    try {
        $page = Invoke-WebRequest -Uri "https://nginx.org/en/download.html" -UseBasicParsing -TimeoutSec 15
        if ($page.Content -match "download/(nginx-1\.(?:2[6-9]|[3-9]\d)\.\d+\.zip)") {
            $downloadUrl = "https://nginx.org/download/$($Matches[1])"
        } elseif ($page.Content -match "download/(nginx-\d+\.\d+\.\d+\.zip)") {
            $downloadUrl = "https://nginx.org/download/$($Matches[1])"
        }
    } catch {
        Write-Info "Could not query nginx.org download page; using fallback $fallbackUrl"
    }

    $tmpZip = Join-Path $env:TEMP "tylertube-nginx.zip"
    $tmpExtract = Join-Path $env:TEMP "tylertube-nginx-extract"
    try {
        Write-Info "Downloading $downloadUrl ..."
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -UseBasicParsing -TimeoutSec 60
        if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
        Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force

        $inner = Get-ChildItem -Path $tmpExtract -Directory | Select-Object -First 1
        if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName "nginx.exe"))) {
            throw "Extracted archive did not contain nginx.exe"
        }
        if (-not (Test-Path $TargetDir)) {
            New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
        }
        Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $TargetDir -Recurse -Force
        [Environment]::SetEnvironmentVariable("NGINX_DIR", $TargetDir, "User")
        $env:NGINX_DIR = $TargetDir
        Add-ToUserPath $TargetDir
        return $true
    } catch {
        Write-Fail "Nginx installation failed: $($_.Exception.Message)"
        $ManualActions.Add("Nginx for Windows: Download from https://nginx.org/en/download.html, extract to $TargetDir, and set NGINX_DIR=$TargetDir.")
        return $false
    } finally {
        if (Test-Path $tmpZip) { Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue }
        if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract -ErrorAction SilentlyContinue }
    }
}

# ==============================================================================
Write-Host ""
Write-Host "TylerTube Windows Setup (Resumable)" -ForegroundColor Magenta
Write-Host "===================================" -ForegroundColor Magenta

Refresh-SessionPath

# Locate repo root if this script is run from inside TylerTube
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$InRepo    = (Test-Path (Join-Path $RepoRoot "package.json")) -and ((Get-Content (Join-Path $RepoRoot "package.json") -Raw) -match '"name"\s*:\s*"tylertube"')

if (-not $HasWinget) {
    Write-Warn "winget was not found. Missing tools will be listed under Manual Intervention."
    $ManualActions.Add("App Installer (winget): Install 'App Installer' from Microsoft Store to enable automatic CLI installs.")
}

# ---------- 1. Git ----------
Write-Header "1. Git"
$gitVer = Get-CmdOutput "git" @("--version")
if ($gitVer) {
    Write-Ok "Already installed: $gitVer"
    $AlreadyInstalled.Add("Git ($gitVer)")
} else {
    if (Install-WingetPackage -DisplayName "Git" -PackageId "Git.Git" -ManualHint "Install from https://git-scm.com/download/win") {
        $gitVer = Get-CmdOutput "git" @("--version")
        Write-Ok "Installed: $gitVer"
        $NewlyInstalled.Add("Git ($gitVer)")
    }
}

# ---------- 2. Node.js LTS (>= 18.15) ----------
Write-Header "2. Node.js LTS (>= 18.15)"
$minNode = [version]::new(18, 15, 0)
$nodeRaw = Get-CmdOutput "node" @("--version")
$nodeVer = Parse-Version $nodeRaw
if ($nodeVer -and $nodeVer -ge $minNode) {
    Write-Ok "Already installed: Node $nodeRaw"
    $AlreadyInstalled.Add("Node.js ($nodeRaw)")
} else {
    if ($nodeVer) {
        Write-Warn "Found Node $nodeRaw, which is older than $minNode (fs.statfsSync requires >= 18.15). Upgrading..."
    }
    if (Install-WingetPackage -DisplayName "Node.js LTS" -PackageId "OpenJS.NodeJS.LTS" -ManualHint "Install Node.js LTS (>= 20) from https://nodejs.org/") {
        $nodeRaw = Get-CmdOutput "node" @("--version")
        Write-Ok "Installed: Node $nodeRaw"
        $NewlyInstalled.Add("Node.js ($nodeRaw)")
    }
}

# ---------- 3. Python 3 (>= 3.9) ----------
Write-Header "3. Python 3 (>= 3.9)"
$minPy = [version]::new(3, 9, 0)
$pyInfo = Resolve-Python
if ($pyInfo -and $pyInfo.Version -ge $minPy) {
    Write-Ok "Already installed: $($pyInfo.Raw) ($($pyInfo.Path))"
    $AlreadyInstalled.Add("Python ($($pyInfo.Raw))")
} else {
    if ($pyInfo) {
        Write-Warn "Found $($pyInfo.Raw), which is older than $minPy. Installing Python 3.12..."
    }
    if (Install-WingetPackage -DisplayName "Python 3.12" -PackageId "Python.Python.3.12" -ManualHint "Install Python 3.12 from https://www.python.org/downloads/windows/ (check 'Add python.exe to PATH')") {
        $pyInfo = Resolve-Python
        if ($pyInfo) {
            Write-Ok "Installed: $($pyInfo.Raw)"
            $NewlyInstalled.Add("Python ($($pyInfo.Raw))")
        } else {
            Write-Warn "Python installed, but may require a new terminal to appear on PATH."
            $NewlyInstalled.Add("Python 3.12 (restart terminal to pick up PATH)")
        }
    }
}

# ---------- 4. FFmpeg & FFprobe ----------
Write-Header "4. FFmpeg & FFprobe"
$ffmpegOut  = Get-CmdOutput "ffmpeg" @("-version")
$ffprobeOut = Get-CmdOutput "ffprobe" @("-version")
if ($ffmpegOut -and $ffprobeOut) {
    $firstLine = ($ffmpegOut -split "`n")[0].Trim()
    Write-Ok "Already installed: $firstLine"
    $AlreadyInstalled.Add("FFmpeg & FFprobe")
} else {
    if (Install-WingetPackage -DisplayName "FFmpeg" -PackageId "Gyan.FFmpeg" -ManualHint "Install FFmpeg (with libx264 + ffprobe) from https://www.gyan.dev/ffmpeg/builds/ and add its bin/ folder to PATH.") {
        $ffmpegOut = Get-CmdOutput "ffmpeg" @("-version")
        Write-Ok "Installed FFmpeg & FFprobe"
        $NewlyInstalled.Add("FFmpeg & FFprobe")
    }
}

# ---------- 5. yt-dlp ----------
Write-Header "5. yt-dlp (YouTube & Shorts streaming)"
$ytdlpVer = Get-CmdOutput "yt-dlp" @("--version")
if ($ytdlpVer) {
    Write-Ok "Already installed: yt-dlp $ytdlpVer"
    $AlreadyInstalled.Add("yt-dlp ($ytdlpVer)")
} else {
    if (Install-WingetPackage -DisplayName "yt-dlp" -PackageId "yt-dlp.yt-dlp" -ManualHint "Install yt-dlp from https://github.com/yt-dlp/yt-dlp/releases or 'pip install -U yt-dlp'.") {
        $ytdlpVer = Get-CmdOutput "yt-dlp" @("--version")
        Write-Ok "Installed: yt-dlp $ytdlpVer"
        $NewlyInstalled.Add("yt-dlp ($ytdlpVer)")
    }
}

# ---------- 6. cloudflared ----------
Write-Header "6. cloudflared (Cloudflare quick tunnels)"
$cfVer = Get-CmdOutput "cloudflared" @("--version")
if ($cfVer) {
    Write-Ok "Already installed: $cfVer"
    $AlreadyInstalled.Add("cloudflared ($cfVer)")
} else {
    if (Install-WingetPackage -DisplayName "cloudflared" -PackageId "Cloudflare.cloudflared" -ManualHint "Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/") {
        $cfVer = Get-CmdOutput "cloudflared" @("--version")
        Write-Ok "Installed: $cfVer"
        $NewlyInstalled.Add("cloudflared ($cfVer)")
    }
}

# ---------- 7. Nginx for Windows ----------
Write-Header "7. Nginx for Windows"
$existingNginx = Find-ExistingNginx
if ($existingNginx) {
    Write-Ok "Already installed at $existingNginx"
    $AlreadyInstalled.Add("Nginx ($existingNginx)")
    if (-not $env:NGINX_DIR) {
        [Environment]::SetEnvironmentVariable("NGINX_DIR", $existingNginx, "User")
        $env:NGINX_DIR = $existingNginx
    }
    Add-ToUserPath $existingNginx
} else {
    if (Install-NginxWindows $NginxDir) {
        Write-Ok "Installed Nginx to $NginxDir"
        $NewlyInstalled.Add("Nginx ($NginxDir)")
    }
}

# ---------- 8. Project setup (npm modules, dirs, .env, redirect-site submodule) ----------
if ($InRepo) {
    Write-Header "8. TylerTube Repository Setup ($RepoRoot)"
    Push-Location $RepoRoot
    try {
        # Ensure media & data directories exist
        foreach ($relDir in @("public\videos", "public\thumbnails", "data")) {
            $full = Join-Path $RepoRoot $relDir
            if (-not (Test-Path $full)) {
                New-Item -ItemType Directory -Path $full -Force | Out-Null
                Write-Info "Created $relDir"
            }
        }

        # npm install
        if (-not $SkipNpmInstall) {
            if (-not (Test-Command "npm")) {
                Write-Fail "npm is not on PATH yet; open a new PowerShell window and run 'npm install'."
                $ManualActions.Add("Node modules: Open a new terminal and run 'npm install' in $RepoRoot.")
            } else {
                $nodeModules = Join-Path $RepoRoot "node_modules"
                if (Test-Path $nodeModules) {
                    Write-Info "node_modules exists; running 'npm install' to ensure packages are up to date..."
                } else {
                    Write-Info "Installing Node dependencies via 'npm install'..."
                }
                & npm install
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "npm dependencies are installed"
                    if (Test-Path $nodeModules) { $NewlyInstalled.Add("npm packages (package.json)") }
                } else {
                    Write-Fail "'npm install' exited with $LASTEXITCODE"
                    $ManualActions.Add("Node modules: Run 'npm install' in $RepoRoot and inspect any errors.")
                }
            }
        }

        # .env scaffolding
        $envFile    = Join-Path $RepoRoot ".env"
        $envExample = Join-Path $RepoRoot ".env.example"
        if (Test-Path $envFile) {
            Write-Ok ".env already exists"
            $AlreadyInstalled.Add(".env file")
        } elseif (Test-Path $envExample) {
            Copy-Item $envExample $envFile
            Write-Ok "Created .env from .env.example"
            $NewlyInstalled.Add(".env (copied from .env.example)")
            $ManualActions.Add(".env: Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in $envFile if you want personal YouTube feeds, or set TYLERTUBE_UPLOAD_KEY (or create data\upload-key) to enable browser uploads.")
        }

        # redirect-site submodule
        $redirectGit = Join-Path $RepoRoot "redirect-site\.git"
        if (Test-Path $redirectGit) {
            Write-Ok "redirect-site/ submodule is already initialized"
            $AlreadyInstalled.Add("redirect-site/ submodule")
        } elseif (Test-Command "git") {
            Write-Info "Initializing redirect-site/ submodule..."
            $env:GIT_TERMINAL_PROMPT = "0"
            & git submodule update --init --recursive
            Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
            if ($LASTEXITCODE -eq 0 -and (Test-Path $redirectGit)) {
                Write-Ok "Initialized redirect-site/ submodule"
                $NewlyInstalled.Add("redirect-site/ submodule")
            } else {
                Write-Warn "Could not auto-initialize redirect-site/ (likely needs GitHub sign-in)."
                $ManualActions.Add("redirect-site/ repo: Sign in to GitHub for Git, then run 'git submodule update --init --recursive' (or 'git clone https://github.com/tylerhu3/RedirectUrl.git redirect-site').")
            }
        }

        # Git identity & GitHub credential check (required by scripts/tunnel.mjs when pushing redirects)
        if (Test-Command "git") {
            $gitName  = Get-CmdOutput "git" @("config", "--get", "user.name")
            $gitEmail = Get-CmdOutput "git" @("config", "--get", "user.email")
            if (-not $gitName -or -not $gitEmail) {
                Write-Warn "Git user.name / user.email not configured (needed for tunnel redirect commits)."
                $ManualActions.Add("Git identity: Run 'git config --global user.name `"Your Name`"' and 'git config --global user.email `"you@example.com`"'.")
            } else {
                Write-Ok "Git identity configured ($gitName <$gitEmail>)"
            }

            $env:GIT_TERMINAL_PROMPT = "0"
            $lsRemote = Get-CmdOutput "git" @("ls-remote", "https://github.com/tylerhu3/RedirectUrl.git", "HEAD")
            Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
            if (-not $lsRemote) {
                Write-Warn "Non-interactive Git access to github.com/tylerhu3/RedirectUrl.git did not succeed."
                $ManualActions.Add("GitHub auth: Authenticate Git Credential Manager so scripts/tunnel.mjs can push without prompting (e.g. run 'git -C redirect-site fetch origin' once and complete the browser login).")
            } else {
                Write-Ok "Git can reach github.com/tylerhu3/RedirectUrl.git non-interactively"
            }
        }

        # Optional verification
        if (-not $SkipVerify -and (Test-Command "npm")) {
            Write-Header "9. Verification (npm run check & npm test)"
            & npm run check
            $checkOk = ($LASTEXITCODE -eq 0)
            & npm test
            $testOk = ($LASTEXITCODE -eq 0)
            if ($checkOk -and $testOk) {
                Write-Ok "Static check and unit tests passed"
            } else {
                Write-Warn "Verification reported issues (check: $checkOk, test: $testOk)."
                $ManualActions.Add("Verification: Open a fresh terminal and run 'npm run check && npm test' to inspect any errors.")
            }
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Warn "Not running inside a TylerTube checkout; skipped repo-specific steps (npm install, submodule, .env)."
    $ManualActions.Add("Clone repo: Run 'git clone --recurse-submodules https://github.com/tylerhu3/TylerTube.git' and re-run this script inside it.")
}

# ==============================================================================
# Summary Report
# ==============================================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  TylerTube Windows Setup Summary" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

Write-Host ""
Write-Host "Already installed:" -ForegroundColor Green
if ($AlreadyInstalled.Count -eq 0) {
    Write-Host "  (none)" -ForegroundColor Gray
} else {
    foreach ($item in $AlreadyInstalled) { Write-Host "  - $item" -ForegroundColor Green }
}

Write-Host ""
Write-Host "Installed / configured in this run:" -ForegroundColor Cyan
if ($NewlyInstalled.Count -eq 0) {
    Write-Host "  (none)" -ForegroundColor Gray
} else {
    foreach ($item in $NewlyInstalled) { Write-Host "  - $item" -ForegroundColor Cyan }
}

Write-Host ""
Write-Host "Needs manual intervention:" -ForegroundColor Yellow
if ($ManualActions.Count -eq 0) {
    Write-Host "  (none - all automated checks passed!)" -ForegroundColor Green
} else {
    foreach ($item in $ManualActions) { Write-Host "  * $item" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  Next Steps" -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host @"

1. Open a NEW PowerShell window so all updated PATH and NGINX_DIR changes take effect.

2. Make sure the redirect-site/ repo is cloned and Git can push to GitHub:
   cd "$RepoRoot"
   git submodule update --init --recursive
   # (Or if cloned without submodules: git clone https://github.com/tylerhu3/RedirectUrl.git redirect-site)
   git -C redirect-site fetch origin   # triggers GitHub login once if not signed in yet

3. Copy your media and optional secrets from your Mac:
   - Videos:       public\videos\
   - Thumbnails:   public\thumbnails\  (or let 'npm run build' regenerate them)
   - Upload key:   data\upload-key     (optional, >= 12 chars, to enable browser uploads)
   - OAuth / env:  .env                (optional, for YouTube personal feeds)

4. Start TylerTube in production (builds app, configures & starts Nginx, stream server,
   tunnel keeper, and publishes the Cloudflare tunnel URL to redirect-site/):
   npm run deploy:public

   (Tip: run 'npm run deploy:public -- --dry-run' first to test the build without starting services.)
   (For local development only: 'npm run dev' on http://localhost:5173)

5. Check tunnel status at any time:
   npm run tunnel status

   Logs on Windows are written to: %TEMP%\tylertube-*.log
"@ -ForegroundColor White
