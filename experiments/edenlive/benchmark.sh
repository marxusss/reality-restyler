#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
root="$PWD"
mkdir -p results cache models
exec > >(tee "$root/results/benchmark.log") 2>&1
export HF_HOME="$root/cache/huggingface" PIP_CACHE_DIR="$root/cache/pip" TORCH_HOME="$root/cache/torch"
export TRITON_CACHE_DIR="$root/cache/triton" TORCHINDUCTOR_CACHE_DIR="$root/cache/inductor"
export TMPDIR="$root/cache/tmp" MAX_JOBS=4 CMAKE_BUILD_PARALLEL_LEVEL=4
mkdir -p "$TMPDIR"
nvidia-smi
free_mib=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)
if (( free_mib < 27000 )); then echo "GPU busy or insufficient free VRAM: $free_mib MiB"; exit 1; fi
available=$(df -Pk "$root" | awk 'NR==2 {print $4}')
if (( available < 80*1024*1024 )); then echo "Need 80 GiB free on F: for initial conversion and environment"; exit 1; fi
nvcc --version
if [[ ! -d LightX2V/.git ]]; then git clone --depth 1 https://github.com/ModelTC/LightX2V.git; fi
if [[ ! -d EdenLive/.git ]]; then git clone --depth 1 https://github.com/VAST-AI-Research/EdenLive.git; fi
git -C LightX2V rev-parse HEAD
git -C EdenLive rev-parse HEAD
# An isolated environment; never alter Reality Restyler's Python or packages.
if [[ ! -x venv/bin/python ]]; then python3 -m venv --copies venv; fi
source venv/bin/activate
python -m pip install --upgrade pip setuptools wheel packaging ninja
if ! python -c 'import torch; assert torch.cuda.is_available(); assert torch.cuda.get_device_capability()==(12,0)' ; then
  cuda=cu128
  if nvcc --version | grep -q 'release 13'; then cuda=cu130; fi
  python -m pip install torch torchvision torchaudio --index-url "https://download.pytorch.org/whl/$cuda"
fi
python -c 'import torch; print(torch.__version__,torch.version.cuda,torch.cuda.get_device_name()); assert torch.cuda.get_device_capability()==(12,0)'
cd "$root/LightX2V"
python -m pip install -e .
python -m pip install huggingface_hub scikit_build_core uv sgl-kernel flashinfer-python
if ! python -c 'import sageattention'; then
  if [[ ! -d "$root/SageAttention/.git" ]]; then git clone --depth 1 https://github.com/thu-ml/SageAttention.git "$root/SageAttention"; fi
  CUDA_ARCHITECTURES=12.0 EXT_PARALLEL=2 NVCC_APPEND_FLAGS="--threads 2" python -m pip install --no-build-isolation -e "$root/SageAttention"
fi
if ! python -c 'import lightx2v_kernel_nvidia'; then
  if [[ ! -d "$root/cutlass/.git" ]]; then git clone --depth 1 https://github.com/NVIDIA/cutlass.git "$root/cutlass"; fi
  (cd lightx2v_kernel/nvidia; uv build --wheel -Cbuild-dir=build . -Ccmake.define.CUTLASS_PATH="$root/cutlass" --no-build-isolation; python -m pip install --no-deps dist/*.whl)
fi
python -c 'import torch, lightx2v_kernel_nvidia, sageattention, sgl_kernel, flashinfer, comfy_kitchen; print("GPU kernel imports OK")'
# Download only the 5B AR DiT and shared encoders; skip 14B, bidirectional and FLUX.
export RAW_MODEL="$root/models/EdenLive" MODEL_PATH="$root/models/EdenLive-x2v"
python - <<'PY'
import os
from huggingface_hub import snapshot_download, hf_hub_download
snapshot_download("VAST-AI/EdenLive", local_dir=os.environ["RAW_MODEL"],
    allow_patterns=["dit-5b/*","vae-5b/*","umt5/*","vision-encoder/*","scheduler-5b/*","LICENSE","README.md"])
hf_hub_download("lightx2v/Autoencoders","lighttaew2_2.safetensors",local_dir=os.path.dirname(os.environ["RAW_MODEL"]))
PY
# Use upstream converter functions for just the downloaded 5B variant.
python - <<'PY'
import os, shutil
from pathlib import Path
from tools.convert.convert_edenlive import convert_dit, convert_encoder
src=Path(os.environ["RAW_MODEL"]); dst=Path(os.environ["MODEL_PATH"])
dst.mkdir(exist_ok=True)
convert_dit(src/"dit-5b",dst/"dit-5b",False)
convert_encoder(src/"umt5/text_encoder",dst/"umt5/text_encoder","t5",False)
for name in ("vae-5b","vision-encoder","umt5/tokenizer","scheduler-5b"):
    dest=dst/name
    if not dest.exists():
        try:
            shutil.copytree(src/name,dest,copy_function=os.link)
        except OSError:
            shutil.copytree(src/name,dest,dirs_exist_ok=True)
PY
EDEN_MODEL="$MODEL_PATH" QUANT_DEVICE=cuda:0 bash scripts/edenlive/prepare_fp8_f16_accum_5090.sh
# Use the published sample first so the benchmark is comparable.
export CONFIG_PATH="$root/5090-local.json"
python - <<'PY'
import json,os
from pathlib import Path
p=Path("configs/edenlive/realtime/wan22_5b_ar_fp8_f16_accum_sage_lighttae_async_5090.json")
cfg=json.loads(p.read_text().replace("/path/to/EdenLive-x2v",os.environ["MODEL_PATH"]).replace("/path/to/lighttaew2_2.safetensors",str(Path(os.environ["RAW_MODEL"]).parent/"lighttaew2_2.safetensors")))
Path(os.environ["CONFIG_PATH"]).write_text(json.dumps(cfg,indent=2))
PY
sample="$root/EdenLive/examples/samples/cryo-crossing"
export IMAGE_PATH="$sample/cover.png" VIDEO_PATH="$sample/recording.mp4" OUTPUT_PATH="$root/results/edenlive-720p.mp4"
test -s "$IMAGE_PATH" && test -s "$VIDEO_PATH"
# Keep the artifact small; the full input remains on F:.
cp "$CONFIG_PATH" "$root/results/config.json"
nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu --format=csv -lms 500 > "$root/results/gpu.csv" &
monitor=$!
trap 'kill "$monitor" 2>/dev/null || true' EXIT
CUDA_VISIBLE_DEVICES=0 bash scripts/edenlive/run_5090.sh
test -s "$OUTPUT_PATH"
python - <<'PY'
import os, cv2
p=os.environ["OUTPUT_PATH"]; c=cv2.VideoCapture(p)
assert c.isOpened(), "No decodable output video"
print("Output frames:",c.get(cv2.CAP_PROP_FRAME_COUNT),"FPS:",c.get(cv2.CAP_PROP_FPS),"resolution:",c.get(cv2.CAP_PROP_FRAME_WIDTH),c.get(cv2.CAP_PROP_FRAME_HEIGHT))
assert c.get(cv2.CAP_PROP_FRAME_COUNT)>0
c.release()
PY
