Add-Type -AssemblyName System.Drawing

$outDir = $PSScriptRoot

# Brand colors
$bg = [System.Drawing.Color]::FromArgb(255, 10, 10, 12)       # #0a0a0c
$fg = [System.Drawing.Color]::FromArgb(255, 250, 250, 250)    # #fafafa
$accent = [System.Drawing.Color]::FromArgb(255, 99, 102, 241) # #6366f1 (subtle highlight)

function New-ContactIconPng {
    param(
        [int]$Size,
        [string]$OutFile,
        [bool]$Maskable = $false
    )
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

    # Background — solid rounded rectangle (maskable leaves a larger safe area)
    $cornerRadius = if ($Maskable) { [int]($Size * 0.0) } else { [int]($Size * 0.225) }
    if ($cornerRadius -gt 0) {
        $bgBrush = New-Object System.Drawing.SolidBrush $bg
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $cornerRadius * 2
        $path.AddArc(0, 0, $d, $d, 180, 90)
        $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
        $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
        $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.FillPath($bgBrush, $path)
        $bgBrush.Dispose()
        $path.Dispose()
    } else {
        $bgBrush = New-Object System.Drawing.SolidBrush $bg
        $g.FillRectangle($bgBrush, 0, 0, $Size, $Size)
        $bgBrush.Dispose()
    }

    # For maskable, scale the icon contents into the inner 80% safe zone
    $safeFactor = if ($Maskable) { 0.8 } else { 1.0 }
    $scale = ($Size / 512.0) * $safeFactor
    $offset = ($Size - 512 * $scale) / 2

    $g.TranslateTransform($offset, $offset)
    $g.ScaleTransform($scale, $scale)

    # Draw the contacts icon: person (circle + body) + adjacent person
    $pen = New-Object System.Drawing.Pen $fg, 22
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # Person 1 — main figure
    $headCenterX = 116
    $headCenterY = 96
    $headRadius = 52
    # Head (circle)
    $g.DrawEllipse($pen, $headCenterX - $headRadius, $headCenterY - $headRadius, $headRadius * 2, $headRadius * 2)
    # Body (arc/shoulders)
    $bodyRectX = 24
    $bodyRectY = 158
    $bodyRectW = 184
    $bodyRectH = 122
    $g.DrawArc($pen, $bodyRectX, $bodyRectY, $bodyRectW, $bodyRectH, 0, 180)

    # Person 2 — adjacent figure
    $pen2 = New-Object System.Drawing.Pen $fg, 22
    $pen2.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen2.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # Person 2 head (partial, behind person 1)
    $g.DrawArc($pen2, 160, 56, 200, 100, 270, 90)
    $g.DrawArc($pen2, 160, 56, 200, 200, 270, 90)
    # Person 2 body
    $g.DrawArc($pen2, 200, 158, 184, 122, 0, 180)

    $pen.Dispose()
    $pen2.Dispose()
    $g.Dispose()

    $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Wrote $OutFile ($Size x $Size)" -ForegroundColor Green
}

New-ContactIconPng -Size 192 -OutFile (Join-Path $outDir "icon-192.png")
New-ContactIconPng -Size 512 -OutFile (Join-Path $outDir "icon-512.png")
New-ContactIconPng -Size 512 -OutFile (Join-Path $outDir "icon-maskable-512.png") -Maskable $true
New-ContactIconPng -Size 180 -OutFile (Join-Path $outDir "apple-touch-icon.png")
New-ContactIconPng -Size 32  -OutFile (Join-Path $outDir "favicon-32.png")

Write-Host ""
Write-Host "All PWA icons generated." -ForegroundColor Cyan
