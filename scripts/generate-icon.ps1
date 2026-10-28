# Render the app-owned book/spark mark from vector geometry. Does not read or edit any existing image.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$mediaRoot = Join-Path $workspaceRoot 'duolingo-harmonyos\overlay\AppScope\resources\base\media'
$entryMedia = Join-Path $workspaceRoot 'duolingo-harmonyos\overlay\entry\src\main\resources\base\media'
New-Item -ItemType Directory -Force -Path $mediaRoot, $entryMedia | Out-Null
function New-BookMark([System.Drawing.Graphics]$canvas) {
  $canvas.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $page = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $page.AddBezier(108, 160, 160, 140, 205, 146, 256, 176)
  $page.AddLine(256, 176, 256, 362)
  $page.AddBezier(256, 362, 205, 329, 160, 326, 108, 346)
  $page.CloseFigure()
  $page.AddBezier(256, 176, 307, 146, 352, 140, 404, 160)
  $page.AddLine(404, 160, 404, 346)
  $page.AddBezier(404, 346, 352, 326, 307, 329, 256, 362)
  $page.CloseFigure()
  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $canvas.FillPath($white, $page)
  $foldPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(37, 130, 65), 12)
  $foldPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $foldPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $canvas.DrawLine($foldPen, 256, 181, 256, 338)
  $linePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(179, 224, 173), 10)
  $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $canvas.DrawLine($linePen, 145, 212, 215, 224)
  $canvas.DrawLine($linePen, 145, 251, 215, 263)
  $canvas.DrawLine($linePen, 297, 224, 367, 212)
  $canvas.DrawLine($linePen, 297, 263, 367, 251)
  $spark = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(385, 85), [System.Drawing.PointF]::new(397, 112), [System.Drawing.PointF]::new(424, 124), [System.Drawing.PointF]::new(397, 136), [System.Drawing.PointF]::new(385, 163), [System.Drawing.PointF]::new(373, 136), [System.Drawing.PointF]::new(346, 124), [System.Drawing.PointF]::new(373, 112))
  $gold = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 214, 90))
  $canvas.FillPolygon($gold, $spark)
  $page.Dispose(); $white.Dispose(); $foldPen.Dispose(); $linePen.Dispose(); $gold.Dispose()
}
$background = [System.Drawing.Bitmap]::new(512, 512)
$bg = [System.Drawing.Graphics]::FromImage($background)
$gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Point]::new(0, 0), [System.Drawing.Point]::new(512, 512), [System.Drawing.Color]::FromArgb(105, 195, 63), [System.Drawing.Color]::FromArgb(24, 125, 70))
$bg.FillRectangle($gradient, 0, 0, 512, 512)
$background.Save((Join-Path $mediaRoot 'duo_icon_background.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$foreground = [System.Drawing.Bitmap]::new(512, 512)
$fg = [System.Drawing.Graphics]::FromImage($foreground)
$fg.Clear([System.Drawing.Color]::Transparent)
New-BookMark $fg
$foreground.Save((Join-Path $mediaRoot 'duo_icon_foreground.png'), [System.Drawing.Imaging.ImageFormat]::Png)
New-BookMark $bg
$background.Save((Join-Path $entryMedia 'duo_start_icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$gradient.Dispose(); $bg.Dispose(); $fg.Dispose(); $background.Dispose(); $foreground.Dispose()
