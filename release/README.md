# Duolinguo 1.0.11 未签名安装包

下载此目录下的 5 个 `.part` 文件和 `merge-hap.ps1` 到同一文件夹，在 PowerShell 运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\merge-hap.ps1
```

合并脚本会验证 SHA-256，然后得到 `Duolinguo-1.0.11-unsigned.hap`。HAP 未签名，需要自行签名后安装。脚本不会覆盖已有的输出文件。

SHA-256：`5effb07c09c56b576f041ac246feca169b52d596defd84d8051c2a1ea8a54d80`。
