param(
  [string]$EnvFile = ".env.prod",
  [string]$OutFile = "k8s/monitoring/values.prod.yaml"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path -Path $EnvFile)) {
  Write-Error "Env file not found: $EnvFile"
}

$envMap = @{}
Get-Content -Path $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ([string]::IsNullOrWhiteSpace($line)) { return }
  if ($line.StartsWith("#")) { return }
  $idx = $line.IndexOf("=")
  if ($idx -lt 1) { return }
  $key = $line.Substring(0, $idx).Trim()
  $value = $line.Substring($idx + 1).Trim()
  $envMap[$key] = $value
}

function Get-EnvValue {
  param(
    [hashtable]$Map,
    [string]$Primary,
    [string]$Fallback = "",
    [string]$Default = ""
  )
  if ($Map.ContainsKey($Primary) -and $Map[$Primary] -ne "") { return $Map[$Primary] }
  if ($Fallback -ne "" -and $Map.ContainsKey($Fallback) -and $Map[$Fallback] -ne "") { return $Map[$Fallback] }
  return $Default
}

function Escape-YamlSingleQuoted {
  param([string]$Value)
  return $Value.Replace("'", "''")
}

$grafanaDomain = Get-EnvValue -Map $envMap -Primary "GRAFANA_DOMAIN" -Fallback "NGINX_SERVER_NAME"
$grafanaAdminPassword = Get-EnvValue -Map $envMap -Primary "GRAFANA_ADMIN_PASSWORD" -Fallback "POSTGRES_PASSWORD"
$grafanaTlsSecret = Get-EnvValue -Map $envMap -Primary "GRAFANA_TLS_SECRET" -Default "grafana-tls"
$prometheusRetention = Get-EnvValue -Map $envMap -Primary "PROMETHEUS_RETENTION" -Default "15d"
$prometheusStorageSize = Get-EnvValue -Map $envMap -Primary "PROMETHEUS_STORAGE_SIZE" -Default "20Gi"
$grafanaStorageSize = Get-EnvValue -Map $envMap -Primary "GRAFANA_STORAGE_SIZE" -Default "5Gi"

if ([string]::IsNullOrWhiteSpace($grafanaDomain)) {
  Write-Error "GRAFANA_DOMAIN is empty (set GRAFANA_DOMAIN or NGINX_SERVER_NAME in $EnvFile)"
}

if ([string]::IsNullOrWhiteSpace($grafanaAdminPassword)) {
  Write-Error "GRAFANA_ADMIN_PASSWORD is empty (set it or POSTGRES_PASSWORD in $EnvFile)"
}

$grafanaDomainEsc = Escape-YamlSingleQuoted $grafanaDomain
$grafanaAdminPasswordEsc = Escape-YamlSingleQuoted $grafanaAdminPassword
$grafanaTlsSecretEsc = Escape-YamlSingleQuoted $grafanaTlsSecret
$prometheusRetentionEsc = Escape-YamlSingleQuoted $prometheusRetention
$prometheusStorageSizeEsc = Escape-YamlSingleQuoted $prometheusStorageSize
$grafanaStorageSizeEsc = Escape-YamlSingleQuoted $grafanaStorageSize

$content = @"
grafana:
  adminPassword: '$grafanaAdminPasswordEsc'
  ingress:
    enabled: true
    ingressClassName: nginx
    hosts:
      - '$grafanaDomainEsc'
    tls:
      - secretName: '$grafanaTlsSecretEsc'
        hosts:
          - '$grafanaDomainEsc'
  defaultDashboardsTimezone: utc
  sidecar:
    dashboards:
      enabled: true
      label: grafana_dashboard
      searchNamespace: monitoring
  persistence:
    enabled: true
    size: '$grafanaStorageSizeEsc'

prometheus:
  ingress:
    enabled: false
  prometheusSpec:
    retention: '$prometheusRetentionEsc'
    storageSpec:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: '$prometheusStorageSizeEsc'

alertmanager:
  enabled: true

kube-state-metrics:
  enabled: true

nodeExporter:
  enabled: true
"@

$outDir = Split-Path -Parent $OutFile
if ($outDir -and !(Test-Path -Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

Set-Content -Path $OutFile -Value $content -Encoding utf8
Write-Output "[OK] Rendered $OutFile from $EnvFile"
