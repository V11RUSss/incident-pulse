#!/bin/sh
set -eu

target="/models/${VLLM_MODEL_NAME}"
marker="${target}/.complete"
mkdir -p "${target}" "${HF_HOME:-/cache/huggingface}"

if [ -f "${marker}" ]; then
  echo "model already present: ${target}"
  exit 0
fi

if [ "${MODEL_SKIP_DOWNLOAD:-0}" = "1" ]; then
  echo "MODEL_SKIP_DOWNLOAD=1: using ${target} as is"
  touch "${marker}"
  exit 0
fi

pip install --quiet --no-cache-dir huggingface_hub

download() {
  if [ -n "${HF_TOKEN:-}" ]; then
    hf download "$@" --token "${HF_TOKEN}"
  else
    hf download "$@"
  fi
}

if [ -n "${VLLM_MODEL_FILE}" ]; then
  if [ ! -f "${target}/${VLLM_MODEL_FILE}" ]; then
    download "${VLLM_MODEL_ID}" "${VLLM_MODEL_FILE}" --local-dir "${target}"
  fi
else
  download "${VLLM_MODEL_ID}" --revision "${VLLM_MODEL_REVISION:-main}" --local-dir "${target}"
fi

touch "${marker}"
echo "model ready: ${target}"
