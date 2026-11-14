{{- define "cachet.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "cachet.fullname" -}}
{{- printf "%s" .Release.Name -}}
{{- end -}}

{{- define "cachet.labels" -}}
app.kubernetes.io/name: {{ include "cachet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "cachet.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cachet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "cachet.image" -}}
{{- $repo := .repository -}}
{{- $tag := .tag | default .Chart.AppVersion -}}
{{- if .digest -}}
{{- $ref := printf "%s@%s" $repo .digest -}}
{{- if .registry -}}
{{- printf "%s/%s" .registry $ref -}}
{{- else -}}
{{- $ref -}}
{{- end -}}
{{- else if .registry -}}
{{- printf "%s/%s:%s" .registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{- define "cachet.secretStoreName" -}}
{{- if .Values.secrets.external.createSecretStore -}}
{{ .Values.secrets.external.secretStoreName }}
{{- else -}}
{{ .Values.secrets.external.secretStoreRef }}
{{- end -}}
{{- end -}}

{{- define "cachet.secretsPrefix" -}}
{{- .Values.secrets.external.prefix | default (printf "cachet-%s/runtime" .Values.env) -}}
{{- end -}}

{{- define "cachet.componentSelectorLabels" -}}
{{- include "cachet.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}
