#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
fi

load_dotenv() {
  [ -f .env ] || return 0
  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      ''|'#'*) continue ;;
    esac
    value="${value%$'\r'}"
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < .env
}
load_dotenv

MODE="${AI_MODE:-auto}"
ENGINE="${AI_ENGINE:-auto}"
PROVIDER="${AI_PROVIDER:-custom}"
PROVIDER_SET=0
BASE_URL_ARG=""
MODEL_ARG=""
KEY_ARG=""
PORT_ARG=""
MODEL_ID_ARG=""
MODEL_NAME_ARG=""
MODEL_FILE_ARG=""
MAX_LEN_ARG=""
GPU_UTIL_ARG=""
VLLM_PORT_ARG=""
REBUILD=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Incident Pulse — два AI-режима.

  ./start.sh --mode=api --base-url=<url> --model=<model> [--api-key=<key>]
      Любой OpenAI-совместимый endpoint: vLLM, DeepSeek, OpenAI,
      удалённый Ollama, llama.cpp-server, LM Studio.

  ./start.sh --mode=vllm [--engine=auto|nvidia|intel|cpu]
      Локальный движок. auto определяет:
        nvidia → vLLM CUDA + Qwen2.5-7B-AWQ
        intel  → vLLM XPU + Qwen2.5-7B-GPTQ-Int4
        cpu    → llama.cpp + Qwen2.5-7B-Q4_K_M
      Модель скачивается в ./models/<name>, кэш — ./cache/huggingface.

  ./start.sh
      auto: если AI_BASE_URL в .env задан — api, иначе vllm.

Параметры:
  --mode=auto|api|vllm|local   режим (local = vllm)
  --engine=auto|nvidia|intel|cpu
  --provider=deepseek|openai|custom  пресет классического API
  --base-url=<url>             для api, обычно с /v1
  --model=<name>               имя модели для api
  --api-key=<key>              ключ для api (можно пустой)
  --model-id=<hf-repo>         HF repo для vllm (переопределяет config)
  --model-name=<dir>           каталог модели в ./models и served name
  --model-file=<file.gguf>     файл GGUF для cpu
  --max-model-len=<n>          контекст
  --gpu-memory-utilization=<x> доля VRAM для vLLM
  --vllm-port=<port>           порт vLLM на localhost (по умолчанию 8002)
  --port=<port>                порт дашборда (по умолчанию 8080)
  --rebuild                    пересобрать app
  --dry-run                    показать выбранный режим/команду без запуска
  -h, --help
EOF
}

die() {
  printf 'Ошибка: %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode=*|--ai=*) MODE="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --mode|--ai)
      [ $# -ge 2 ] || die "для $1 нужно значение"
      MODE="$2"; shift ;;
    --engine=*) ENGINE="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --engine)
      [ $# -ge 2 ] || die "для --engine нужно значение"
      ENGINE="$2"; shift ;;
    --provider=*) PROVIDER="$(printf '%s' "$1" | cut -d= -f2-)"; PROVIDER_SET=1 ;;
    --provider)
      [ $# -ge 2 ] || die "для --provider нужно значение"
      PROVIDER="$2"; PROVIDER_SET=1; shift ;;
    --base-url=*) BASE_URL_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --base-url)
      [ $# -ge 2 ] || die "для --base-url нужно значение"
      BASE_URL_ARG="$2"; shift ;;
    --model=*) MODEL_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --model)
      [ $# -ge 2 ] || die "для --model нужно значение"
      MODEL_ARG="$2"; shift ;;
    --api-key=*) KEY_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --api-key)
      [ $# -ge 2 ] || die "для --api-key нужно значение"
      KEY_ARG="$2"; shift ;;
    --model-id=*) MODEL_ID_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --model-id)
      [ $# -ge 2 ] || die "для --model-id нужно значение"
      MODEL_ID_ARG="$2"; shift ;;
    --model-name=*) MODEL_NAME_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --model-name)
      [ $# -ge 2 ] || die "для --model-name нужно значение"
      MODEL_NAME_ARG="$2"; shift ;;
    --model-file=*) MODEL_FILE_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --model-file)
      [ $# -ge 2 ] || die "для --model-file нужно значение"
      MODEL_FILE_ARG="$2"; shift ;;
    --max-model-len=*) MAX_LEN_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --max-model-len)
      [ $# -ge 2 ] || die "для --max-model-len нужно значение"
      MAX_LEN_ARG="$2"; shift ;;
    --gpu-memory-utilization=*) GPU_UTIL_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --gpu-memory-utilization)
      [ $# -ge 2 ] || die "для --gpu-memory-utilization нужно значение"
      GPU_UTIL_ARG="$2"; shift ;;
    --vllm-port=*) VLLM_PORT_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --vllm-port)
      [ $# -ge 2 ] || die "для --vllm-port нужно значение"
      VLLM_PORT_ARG="$2"; shift ;;
    --port=*) PORT_ARG="$(printf '%s' "$1" | cut -d= -f2-)" ;;
    --port)
      [ $# -ge 2 ] || die "для --port нужно значение"
      PORT_ARG="$2"; shift ;;
    --rebuild) REBUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
  shift
done

[ -n "$PORT_ARG" ] && export APP_HOST_PORT="$PORT_ARG"
[ -n "$VLLM_PORT_ARG" ] && export VLLM_HOST_PORT="$VLLM_PORT_ARG"
HOST_PORT="${APP_HOST_PORT:-8080}"

if [ "$MODE" = "local" ]; then MODE="vllm"; fi
if [ "$MODE" = "auto" ]; then
  if [ "$PROVIDER_SET" = "1" ] || [ "$PROVIDER" != "custom" ] || [ -n "${AI_BASE_URL:-}" ]; then
    MODE="api"
  else
    MODE="vllm"
  fi
fi
case "$MODE" in api|vllm) ;; *) die "mode должен быть auto, api или vllm" ;; esac

command -v docker >/dev/null 2>&1 || die "Docker не найден"
docker compose version >/dev/null 2>&1 || die "нужен Docker Compose v2 (docker compose)"

detect_engine() {
  if command -v nvidia-smi >/dev/null 2>&1 && docker info 2>/dev/null | grep -qi nvidia; then
    printf 'nvidia'
    return
  fi
  if [ -e /dev/dri/renderD128 ]; then
    printf 'intel'
    return
  fi
  printf 'cpu'
}

if [ "$MODE" = "api" ]; then
  DEFAULT_BASE=""
  DEFAULT_MODEL=""
  case "$PROVIDER" in
    deepseek)
      DEFAULT_BASE="https://api.deepseek.com"
      DEFAULT_MODEL="deepseek-chat" ;;
    openai)
      DEFAULT_BASE="https://api.openai.com/v1"
      DEFAULT_MODEL="gpt-4o-mini" ;;
    custom) ;;
    *) die "provider должен быть deepseek, openai или custom" ;;
  esac
  if [ "$PROVIDER_SET" = "1" ]; then
    BASE_URL="${BASE_URL_ARG:-$DEFAULT_BASE}"
    MODEL="${MODEL_ARG:-$DEFAULT_MODEL}"
  else
    BASE_URL="${BASE_URL_ARG:-${AI_BASE_URL:-$DEFAULT_BASE}}"
    MODEL="${MODEL_ARG:-${AI_MODEL:-$DEFAULT_MODEL}}"
  fi
  KEY="${KEY_ARG:-${AI_API_KEY:-}}"
  [ -n "$BASE_URL" ] || die "для api нужен --base-url (или AI_BASE_URL в .env)"
  [ -n "$MODEL" ] || die "для api нужен --model (или AI_MODEL в .env)"
  if [ "$PROVIDER" != "custom" ] && [ -z "$KEY" ]; then
    die "для $PROVIDER нужен --api-key (или AI_API_KEY в .env)"
  fi
  export AI_BASE_URL="$BASE_URL" AI_MODEL="$MODEL" AI_API_KEY="$KEY"
  # остановить локальный движок, если он остался от vllm-режима
  docker compose -f docker-compose.yml -f docker-compose.vllm.yml -f docker-compose.vllm-cpu.yml --profile vllm stop vllm model-init >/dev/null 2>&1 || true
  COMPOSE=(docker compose -f docker-compose.yml)
  printf 'Режим: api/%s (%s, модель %s).\n' "$PROVIDER" "$AI_BASE_URL" "$AI_MODEL"
else
  if [ "$ENGINE" = "auto" ]; then ENGINE="$(detect_engine)"; fi
  case "$ENGINE" in nvidia|intel|cpu) ;; *) die "engine должен быть auto, nvidia, intel или cpu" ;; esac
  CONFIG="config/ai/${ENGINE}.env"
  [ -f "$CONFIG" ] || die "нет конфига $CONFIG"
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
  [ -n "$MODEL_ID_ARG" ] && export VLLM_MODEL_ID="$MODEL_ID_ARG"
  [ -n "$MODEL_NAME_ARG" ] && export VLLM_MODEL_NAME="$MODEL_NAME_ARG"
  [ -n "$MODEL_FILE_ARG" ] && export VLLM_MODEL_FILE="$MODEL_FILE_ARG"
  [ -n "$MAX_LEN_ARG" ] && export VLLM_MAX_MODEL_LEN="$MAX_LEN_ARG"
  [ -n "$GPU_UTIL_ARG" ] && export VLLM_GPU_MEMORY_UTILIZATION="$GPU_UTIL_ARG"
  mkdir -p models cache/huggingface
  mkdir -p "models/${VLLM_MODEL_NAME}"
  COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.vllm.yml -f "docker-compose.vllm-${ENGINE}.yml" --profile vllm)
  printf 'Режим: vllm (%s, модель %s).\n' "$ENGINE" "$AI_MODEL"
  printf 'Модель: ./models/%s (скачается при необходимости)\n' "$VLLM_MODEL_NAME"
  if [ "$ENGINE" = "cpu" ]; then
    printf 'CPU-режим: 7B Q4 может отвечать медленно; при нехватке скорости задайте --model-id меньшей модели.\n'
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  if [ "$MODE" = "api" ]; then
    printf 'DRY-RUN mode=api model=%s base=%s\n' "$AI_MODEL" "$AI_BASE_URL"
  else
    printf 'DRY-RUN mode=vllm engine=%s model=%s dir=%s/models/%s\n' "$ENGINE" "$AI_MODEL" "$PWD" "$VLLM_MODEL_NAME"
  fi
  printf 'compose:'
  printf ' %s' "${COMPOSE[@]}"
  printf '\n'
  exit 0
fi

UP=(up -d --remove-orphans)
[ "$REBUILD" = "1" ] && UP+=(--build)
printf 'Запускаю Docker Compose...\n'
"${COMPOSE[@]}" "${UP[@]}"

wait_app() {
  local i
  for ((i = 0; i < 100; i++)); do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -m 2 "http://127.0.0.1:${HOST_PORT}/api/v1/health" >/dev/null 2>&1 && return 0
    else
      "${COMPOSE[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  return 1
}

wait_engine() {
  local i port="${VLLM_HOST_PORT:-8002}"
  for ((i = 0; i < 360; i++)); do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -m 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1 && return 0
    else
      if "${COMPOSE[@]}" logs --no-log-prefix vllm 2>/dev/null | grep -qiE 'listening|Application startup complete'; then
        return 0
      fi
      "${COMPOSE[@]}" exec -T vllm python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)" >/dev/null 2>&1 && return 0
    fi
    if (( i > 0 && i % 12 == 0 )); then
      printf 'Жду загрузку модели/движка... (%d сек)\n' "$((i * 5))"
    fi
    sleep 5
  done
  return 1
}

if ! wait_app; then
  printf 'Приложение не поднялось. Логи:\n' >&2
  docker compose logs --tail=80 app >&2 || true
  exit 1
fi

if [ "$MODE" = "vllm" ]; then
  if ! wait_engine; then
    printf 'Движок не поднялся. Логи model-init/vllm:\n' >&2
    "${COMPOSE[@]}" logs --tail=120 model-init vllm >&2 || true
    exit 1
  fi
fi

printf '\nГотово.\n'
if [ "$MODE" = "api" ]; then
  printf 'Режим:   api (%s, модель %s)\n' "$AI_BASE_URL" "$AI_MODEL"
else
  printf 'Режим:   vllm/%s (модель %s)\n' "$ENGINE" "$AI_MODEL"
  printf 'Модель:  %s/models/%s\n' "$PWD" "$VLLM_MODEL_NAME"
fi
printf 'Дашборд: http://localhost:%s\n' "$HOST_PORT"
printf 'Первый зарегистрированный пользователь становится администратором.\n'
