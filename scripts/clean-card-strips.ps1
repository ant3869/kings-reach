param(
    [string]$Directory = (Join-Path $PSScriptRoot '..\public\card-states')
)

Add-Type -AssemblyName System.Drawing

function Test-BackgroundPixel([System.Drawing.Color]$Color) {
    $maximum = [Math]::Max($Color.R, [Math]::Max($Color.G, $Color.B))
    $minimum = [Math]::Min($Color.R, [Math]::Min($Color.G, $Color.B))
    return $Color.A -gt 0 -and $minimum -ge 242 -and ($maximum - $minimum) -le 8
}

Get-ChildItem -LiteralPath $Directory -Filter 'warroom-cards-*.png' |
    Where-Object { $_.BaseName -notlike '*-clean' } |
    ForEach-Object {
        $source = $_.FullName
        $target = Join-Path $_.DirectoryName ($_.BaseName + '-clean.png')
        $sourceBitmap = [System.Drawing.Bitmap]::new($source)
        $bitmap = [System.Drawing.Bitmap]::new($sourceBitmap.Width, $sourceBitmap.Height,
            [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.DrawImageUnscaled($sourceBitmap, 0, 0)
        $graphics.Dispose()
        $sourceBitmap.Dispose()
        $removed = 0

        for ($y = 0; $y -lt $bitmap.Height; $y++) {
            for ($x = 0; $x -lt $bitmap.Width; $x++) {
                if (Test-BackgroundPixel $bitmap.GetPixel($x, $y)) {
                    $bitmap.SetPixel($x, $y, [System.Drawing.Color]::Transparent)
                    $removed++
                }
            }
        }

        $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
        Write-Host "$($_.Name): removed $removed neutral-white pixels -> $(Split-Path $target -Leaf)"
    }

$splitter = Join-Path $PSScriptRoot 'split-card-states.ps1'
& $splitter -SourceDir $Directory -OutputDir (Join-Path $Directory 'individual')
