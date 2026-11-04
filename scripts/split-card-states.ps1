param(
    [string]$SourceDir = "public\card-states",
    [string]$OutputDir = "public\card-states\individual"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$roles = @("main", "research", "comms", "content", "ops")
# Idle only. The thinking/speaking/building cards are generated one card at a time and built by
# scripts/build_card_art.py; re-splitting the old strips here would overwrite that art.
$states = @("idle")
$targetWidth = 213
$targetHeight = 313
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Find-CardRuns([System.Drawing.Bitmap]$bitmap) {
    $activeColumns = New-Object System.Collections.Generic.List[int]
    for ($x = 0; $x -lt $bitmap.Width; $x++) {
        $opaquePixels = 0
        for ($y = 0; $y -lt $bitmap.Height; $y++) {
            if ($bitmap.GetPixel($x, $y).A -gt 16) { $opaquePixels++ }
        }
        if ($opaquePixels -gt 8) { $activeColumns.Add($x) }
    }

    $runs = New-Object System.Collections.Generic.List[object]
    $start = $activeColumns[0]
    $last = $start
    foreach ($x in $activeColumns | Select-Object -Skip 1) {
        if ($x - $last -gt 4) {
            $runs.Add(@($start, $last))
            $start = $x
        }
        $last = $x
    }
    $runs.Add(@($start, $last))
    return $runs
}

foreach ($state in $states) {
    $source = Join-Path $SourceDir "warroom-cards-$state-clean.png"
    $bitmap = [System.Drawing.Bitmap]::FromFile((Resolve-Path $source))
    try {
        $runs = @(Find-CardRuns $bitmap)
        if ($runs.Count -ne $roles.Count) {
            throw "$source contains $($runs.Count) detected card regions; expected $($roles.Count)"
        }

        for ($index = 0; $index -lt $roles.Count; $index++) {
            $left = [int]$runs[$index][0]
            $right = [int]$runs[$index][1]
            $sourceRect = [System.Drawing.Rectangle]::new($left, 0, $right - $left + 1, $bitmap.Height)
            $output = [System.Drawing.Bitmap]::new(
                $targetWidth, $targetHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            try {
                $graphics = [System.Drawing.Graphics]::FromImage($output)
                try {
                    $graphics.Clear([System.Drawing.Color]::Transparent)
                    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
                    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                    $destination = [System.Drawing.Rectangle]::new(0, 0, $targetWidth, $targetHeight)
                    $graphics.DrawImage($bitmap, $destination, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
                } finally {
                    $graphics.Dispose()
                }
                $path = Join-Path $OutputDir "$state-$($roles[$index]).png"
                $output.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
                Write-Host "$path <= x=$left..$right"
            } finally {
                $output.Dispose()
            }
        }
    } finally {
        $bitmap.Dispose()
    }
}
